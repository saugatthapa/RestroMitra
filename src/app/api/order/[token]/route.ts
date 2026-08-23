import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables, restaurants, orders, orderItems, orderItemAddons } from "@/db/schema";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { submitPublicOrderSchema } from "@/lib/validation/orders";
import { computeOrderPricing, generateOrderNumber } from "@/lib/orders";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { isUniqueViolation } from "@/lib/db-error";
import { assertTableAcceptsOrders, syncTableStatusFromOrders } from "@/lib/tables";
import { publishEvent } from "@/lib/realtime";
import { sendPushToRestaurant } from "@/lib/push";
import { formatNPR } from "@/lib/money";

/**
 * Public, UNAUTHENTICATED endpoint — a customer's phone hits this after
 * scanning a table's QR code. There is no session, so there is no
 * permission check; the entire trust boundary is the qrToken itself
 * (high-entropy, resolved server-side to exactly one table/restaurant) and
 * server-side price computation (computeOrderPricing never trusts a
 * client-submitted price). Being unauthenticated and open to the internet,
 * this is the most abuse-prone route in the app so far — rate limited by
 * both IP and table.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { token } = await ctx.params;

    const ip = getClientIp(request) ?? "unknown";
    const ipLimit = rateLimit(`order:ip:${ip}`, { limit: 15, windowMs: 10 * 60 * 1000 });
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many orders submitted. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }
    const tokenLimit = rateLimit(`order:token:${token}`, { limit: 20, windowMs: 10 * 60 * 1000 });
    if (!tokenLimit.allowed) {
      return NextResponse.json(
        { error: "Too many orders from this table. Please ask staff for help." },
        { status: 429 },
      );
    }

    const tableRows = await db
      .select({
        tableId: restaurantTables.id,
        tableName: restaurantTables.name,
        branchId: restaurantTables.branchId,
        tableIsActive: restaurantTables.isActive,
        restaurantId: restaurants.id,
        restaurantIsActive: restaurants.isActive,
        restaurantTimezone: restaurants.timezone,
      })
      .from(restaurantTables)
      .innerJoin(restaurants, eq(restaurantTables.restaurantId, restaurants.id))
      .where(eq(restaurantTables.qrToken, token))
      .limit(1);

    const resolved = tableRows[0];
    if (!resolved || !resolved.tableIsActive || !resolved.restaurantIsActive) {
      return NextResponse.json(
        { error: "This table is not available for ordering right now." },
        { status: 404 },
      );
    }

    const parsed = await parseJsonBody(request, submitPublicOrderSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // P0-2 idempotent create: if this exact submission attempt (identified
    // by clientRequestId, not the order itself) already landed — a flaky
    // mobile connection retrying after the server already committed, or the
    // menu's own double-submit guard racing a slow response — hand back
    // the original order instead of creating a second one. Checked up
    // front (cheap, avoids doing pricing work for what's almost always a
    // no-op) AND after insert (handles the race where two retries land
    // concurrently — see the 23505 handling in the retry loop below). Same
    // pattern as the staff order route (orders/route.ts), which this route
    // never had until now despite being the higher-risk one: no staff
    // oversight to notice a duplicate, on the flakiest network conditions
    // (a guest's own phone).
    if (body.clientRequestId) {
      const existingRows = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.restaurantId, resolved.restaurantId),
            eq(orders.clientRequestId, body.clientRequestId),
          ),
        )
        .limit(1);
      if (existingRows[0]) {
        return NextResponse.json(
          {
            order: {
              id: existingRows[0].id,
              orderNumber: existingRows[0].orderNumber,
              status: existingRows[0].status,
              subtotalInPaisa: existingRows[0].subtotalInPaisa,
              taxInPaisa: existingRows[0].taxInPaisa,
              totalInPaisa: existingRows[0].totalInPaisa,
            },
            tableName: resolved.tableName,
            idempotentReplay: true,
          },
          { status: 200 },
        );
      }
    }

    const pricing = await computeOrderPricing(
      resolved.restaurantId,
      body.items.map((item) => ({
        menuItemId: item.menuItemId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        addons: item.addonIds.map((addonId) => ({ addonId })),
        notes: item.notes,
      })),
    );

    // Wrap the order number generation + insert in a small retry loop: the
    // (restaurant_id, order_number) unique index is what actually
    // guarantees no collision, not the randomness of generateOrderNumber()
    // alone (astronomically unlikely, but "astronomically unlikely" isn't
    // the same guarantee as "enforced").
    let insertedOrder: typeof orders.$inferSelect | undefined;
    let idempotentReplay = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !insertedOrder; attempt++) {
      try {
        insertedOrder = await db.transaction(async (tx) => {
          await assertTableAcceptsOrders(tx, resolved.tableId);

          const [order] = await tx
            .insert(orders)
            .values({
              restaurantId: resolved.restaurantId,
              branchId: resolved.branchId,
              tableId: resolved.tableId,
              orderNumber: generateOrderNumber(resolved.restaurantTimezone),
              source: "qr_customer",
              status: "pending",
              customerName: body.customerName || null,
              customerPhone: body.customerPhone || null,
              notes: body.notes || null,
              clientRequestId: body.clientRequestId || null,
              subtotalInPaisa: pricing.subtotalInPaisa,
              taxInPaisa: pricing.taxInPaisa,
              totalInPaisa: pricing.totalInPaisa,
            })
            .returning();

          // Perf: previously this looped one cart item at a time — insert
          // the item, then (if it had addons) a second insert for those —
          // meaning a 5-item order with addons on every item cost up to 10
          // sequential round trips here alone, scaling linearly with cart
          // size. Generating each item's id up front (instead of relying on
          // the column default + a `.returning()` round trip to learn it)
          // lets every item go in ONE batched insert, and every addon
          // across the whole order go in a second batched insert — this
          // section is now exactly 2 round trips (1 if nothing in the cart
          // has addons), regardless of how many items are in the cart. See
          // PERFORMANCE_AUDIT.md — this was the single biggest lever in how
          // long it takes before the new-order alert can fire.
          const itemRows = pricing.items.map((item) => ({
            id: randomUUID(),
            orderId: order.id,
            menuItemId: item.menuItemId,
            menuItemNameSnapshot: item.menuItemNameSnapshot,
            variantId: item.variantId,
            variantNameSnapshot: item.variantNameSnapshot,
            kitchenStationId: item.kitchenStationId,
            kitchenStationNameSnapshot: item.kitchenStationNameSnapshot,
            unitPriceInPaisa: item.unitPriceInPaisa,
            quantity: item.quantity,
            lineSubtotalInPaisa: item.lineSubtotalInPaisa,
            addonsTotalInPaisa: item.addonsTotalInPaisa,
            lineTotalInPaisa: item.lineTotalInPaisa,
            notes: item.notes,
          }));
          await tx.insert(orderItems).values(itemRows);

          const addonRows = pricing.items.flatMap((item, index) =>
            item.addons.map((addon) => ({
              orderItemId: itemRows[index].id,
              addonId: addon.addonId,
              nameSnapshot: addon.nameSnapshot,
              priceInPaisaSnapshot: addon.priceInPaisaSnapshot,
            })),
          );
          if (addonRows.length > 0) {
            await tx.insert(orderItemAddons).values(addonRows);
          }

          await syncTableStatusFromOrders(tx, resolved.tableId);

          return order;
        });
      } catch (err) {
        lastError = err;
        // Unique violation (Postgres code 23505) on the order number —
        // retry with a freshly generated one. Anything else, rethrow.
        // (isUniqueViolation checks both err.code and err.cause.code — see
        // its doc comment for why the latter is the one that actually
        // fires here, since this throws from inside db.transaction().)
        if (!isUniqueViolation(err)) throw err;
        // A unique-index collision here is either the order-number index
        // (loop again with a freshly generated number) or, if a
        // clientRequestId was supplied, possibly a concurrent duplicate
        // submission of the SAME retry racing us (two requests from the
        // same flaky connection both landing at once) — check for that
        // before burning another attempt. Same pattern as the staff order
        // route (orders/route.ts).
        if (body.clientRequestId) {
          const raceRows = await db
            .select()
            .from(orders)
            .where(
              and(
                eq(orders.restaurantId, resolved.restaurantId),
                eq(orders.clientRequestId, body.clientRequestId),
              ),
            )
            .limit(1);
          if (raceRows[0]) {
            insertedOrder = raceRows[0];
            idempotentReplay = true;
          }
        }
      }
    }

    if (!insertedOrder) {
      throw lastError ?? new Error("Failed to create order after retries.");
    }

    if (idempotentReplay) {
      return NextResponse.json(
        {
          order: {
            id: insertedOrder.id,
            orderNumber: insertedOrder.orderNumber,
            status: insertedOrder.status,
            subtotalInPaisa: insertedOrder.subtotalInPaisa,
            taxInPaisa: insertedOrder.taxInPaisa,
            totalInPaisa: insertedOrder.totalInPaisa,
          },
          tableName: resolved.tableName,
          idempotentReplay: true,
        },
        { status: 200 },
      );
    }

    // Perf: the audit log write and the realtime publish are independent —
    // neither reads the other's result — but were previously awaited one
    // after another, adding a full extra round trip before the SSE event
    // (and therefore the dashboard alarm) could fire. Both use the plain
    // `db` pool handle (not a shared transaction), so running them via
    // Promise.all is a genuine second connection in parallel, not just
    // pipelined on one — this is a real, not illusory, latency win.
    await Promise.all([
      recordAuditLog({
        restaurantId: resolved.restaurantId,
        userId: null,
        action: "order.placed",
        resourceType: "order",
        resourceId: insertedOrder.id,
        ipAddress: getClientIp(request),
        metadata: {
          source: "qr_customer",
          tableId: resolved.tableId,
          tableName: resolved.tableName,
          totalInPaisa: insertedOrder.totalInPaisa,
          itemCount: pricing.items.length,
        },
      }),
      publishEvent(db, {
        restaurantId: resolved.restaurantId,
        branchId: resolved.branchId,
        type: "order.created",
        payload: {
          orderId: insertedOrder.id,
          orderNumber: insertedOrder.orderNumber,
          tableId: resolved.tableId,
          tableName: resolved.tableName,
          status: insertedOrder.status,
          totalInPaisa: insertedOrder.totalInPaisa,
        },
      }),
    ]);

    // Phase 25 — the SSE publish above only reaches a tab/app that's
    // currently open; Web Push is what reaches staff whose phone has the
    // app fully closed. `sendPushToRestaurant` never throws (see its own
    // comment) and a slow/failed push service must never delay or fail the
    // order response the guest is waiting on, so this isn't awaited.
    // P0-4: scoped to this order's own branch — a branch-restricted staff
    // member at a DIFFERENT branch of this restaurant must not be paged
    // for an order that isn't theirs. Unrestricted staff (owner/manager)
    // still get it regardless of branch — see sendPushToRestaurant's doc
    // comment.
    void sendPushToRestaurant(
      resolved.restaurantId,
      {
        title: insertedOrder.orderNumber ? `New order #${insertedOrder.orderNumber}` : "New order",
        body: resolved.tableName
          ? `${resolved.tableName} • ${formatNPR(insertedOrder.totalInPaisa)}`
          : formatNPR(insertedOrder.totalInPaisa),
        url: "/dashboard/orders",
        tag: "restromitra-order",
      },
      resolved.branchId,
    );

    return NextResponse.json(
      {
        order: {
          id: insertedOrder.id,
          orderNumber: insertedOrder.orderNumber,
          status: insertedOrder.status,
          subtotalInPaisa: insertedOrder.subtotalInPaisa,
          taxInPaisa: insertedOrder.taxInPaisa,
          totalInPaisa: insertedOrder.totalInPaisa,
        },
        tableName: resolved.tableName,
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
