import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, orderItems, orderItemAddons, restaurantTables, customers, branches } from "@/db/schema";
import {
  resolveRestaurantContext,
  parseJsonBody,
  toErrorResponse,
} from "@/lib/api-route-helpers";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/order-status";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { createStaffOrderSchema } from "@/lib/validation/payments";
import { computeOrderPricing, generateOrderNumber } from "@/lib/orders";
import { getMainBranch } from "@/lib/restaurant";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccess, hasPermission } from "@/lib/rbac/guard";
import { isUniqueViolation } from "@/lib/db-error";
import { assertTableAcceptsOrders, syncTableStatusFromOrders } from "@/lib/tables";
import { computeOrderTotals } from "@/lib/order-adjustments";
import { resolveOrderAdjustmentsInput } from "@/lib/validation/order-adjustments";
import { resolveLoyaltyRedemption } from "@/lib/loyalty-redemption";
import { recordLoyaltyTransaction } from "@/lib/loyalty";

const ORDER_LIST_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
const ORDER_LIST_LIMIT = 200;

/**
 * Lists orders for the restaurant, bounded to a recent time window and a
 * hard row cap rather than full pagination — this is Phase 4's "live
 * board" feed, not a historical report (that's Phase 9). Any staff member
 * with restaurant access can view (same read/write split as menu GETs);
 * only status-changing actions are permission-gated.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(slug);

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status: OrderStatus | null =
      statusParam && ORDER_STATUSES.includes(statusParam as OrderStatus)
        ? (statusParam as OrderStatus)
        : null;

    // Same branch-scoping pattern as the tables list: a branch-restricted
    // caller's own grant always wins; an unrestricted caller can narrow
    // via ?branchId= or see every branch's orders by default.
    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
    }

    const cutoff = new Date(Date.now() - ORDER_LIST_WINDOW_MS);

    const orders = await db.query.orders.findMany({
      where: (o, { and, eq, gte }) =>
        and(
          eq(o.restaurantId, restaurantId),
          gte(o.placedAt, cutoff),
          status ? eq(o.status, status) : undefined,
          effectiveBranchId ? eq(o.branchId, effectiveBranchId) : undefined,
        ),
      orderBy: (o, { desc }) => [desc(o.placedAt)],
      limit: ORDER_LIST_LIMIT,
      with: {
        table: { columns: { id: true, name: true } },
        items: {
          with: { addons: true },
        },
      },
    });

    return NextResponse.json({ orders });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Staff-side ("POS") order creation — a waiter/cashier/manager keying in an
 * order directly, as opposed to a customer submitting one from the public QR
 * page. Requires an authenticated session with CREATE_ORDER; pricing still
 * goes through computeOrderPricing() so staff can't accidentally (or
 * deliberately) key in a price that doesn't match the current menu.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.CREATE_ORDER,
    );

    const parsed = await parseJsonBody(request, createStaffOrderSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    let tableId: string | null = null;
    let branchId: string | null = null;
    if (body.tableId) {
      const tableRows = await db
        .select({ id: restaurantTables.id, branchId: restaurantTables.branchId })
        .from(restaurantTables)
        .where(
          and(
            eq(restaurantTables.id, body.tableId),
            eq(restaurantTables.restaurantId, restaurantId),
          ),
        )
        .limit(1);
      const table = tableRows[0];
      if (!table) {
        return NextResponse.json({ error: "Table not found." }, { status: 404 });
      }
      tableId = table.id;
      branchId = table.branchId;
    } else if (body.branchId) {
      const branchRows = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, body.branchId), eq(branches.restaurantId, restaurantId)))
        .limit(1);
      if (branchRows.length === 0) {
        return NextResponse.json({ error: "Branch not found." }, { status: 404 });
      }
      branchId = branchRows[0].id;
    } else if (grantedBranchId) {
      // A branch-scoped waiter/cashier keying in a takeaway order with no
      // table means "my own branch," not "the restaurant's main branch."
      branchId = grantedBranchId;
    } else {
      // Takeaway / no-table order, unrestricted caller, no explicit branch
      // — falls back to the restaurant's main branch, mirroring the same
      // default used for table creation.
      const main = await getMainBranch(restaurantId);
      if (!main) {
        return NextResponse.json(
          { error: "This restaurant has no branch set up yet." },
          { status: 400 },
        );
      }
      branchId = main.id;
    }

    await requireBranchAccess(session.user.id, restaurantId, branchId, {
      role,
      branchId: grantedBranchId,
    });

    // A client-supplied customerId is never trusted at face value — verify
    // it actually belongs to this restaurant before it can be attached to
    // an order (same "resolve, don't trust" pattern as tableId above).
    // loyaltyPointsBalance is fetched in the same query since a loyalty
    // redemption request (below) needs it and re-querying would be
    // redundant — harmless to select for every order, used or not.
    let customerId: string | null = null;
    let customerLoyaltyPointsBalance = 0;
    if (body.customerId) {
      const customerRows = await db
        .select({ id: customers.id, loyaltyPointsBalance: customers.loyaltyPointsBalance })
        .from(customers)
        .where(and(eq(customers.id, body.customerId), eq(customers.restaurantId, restaurantId)))
        .limit(1);
      if (customerRows.length === 0) {
        return NextResponse.json({ error: "Customer not found." }, { status: 404 });
      }
      customerId = customerRows[0].id;
      customerLoyaltyPointsBalance = customerRows[0].loyaltyPointsBalance;
    }

    // Idempotent create: if this exact submission attempt (identified by
    // clientRequestId, not the order itself) already landed — an offline
    // sync retry, or a flaky connection that timed out after the server
    // already committed — hand back the original order instead of creating
    // a second one. Checked up front (cheap, avoids doing pricing work for
    // what's almost always a no-op) AND after insert (handles the race
    // where two retries land concurrently — see the 23505 handling below).
    if (body.clientRequestId) {
      const existingRows = await db
        .select()
        .from(orders)
        .where(
          and(eq(orders.restaurantId, restaurantId), eq(orders.clientRequestId, body.clientRequestId)),
        )
        .limit(1);
      if (existingRows[0]) {
        return NextResponse.json({ order: existingRows[0], idempotentReplay: true }, { status: 200 });
      }
    }

    const pricing = await computeOrderPricing(
      restaurantId,
      body.items.map((item) => ({
        menuItemId: item.menuItemId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        addons: item.addonIds.map((addonId) => ({ addonId })),
        notes: item.notes,
      })),
    );

    // Phase 13 — discount/service charge at creation time is opt-in and
    // gated behind APPLY_DISCOUNT, checked here (not just relying on the
    // schema) since a Zod schema has no notion of the caller's role. A
    // waiter/cashier without the permission simply never sends
    // `adjustments` from the POS UI; if one somehow did, this rejects it
    // outright rather than silently ignoring it (which would be confusing
    // — "I set a discount and it didn't error, but also didn't apply").
    let discountType: "percentage" | "flat" | null = null;
    let discountValue: number | null = null;
    let discountReason: string | null = null;
    let serviceChargeBasisPoints = 0;
    if (body.adjustments) {
      const canApplyDiscount = await hasPermission(
        session.user.id,
        restaurantId,
        PERMISSIONS.APPLY_DISCOUNT,
        role,
      );
      if (!canApplyDiscount) {
        return NextResponse.json(
          { error: "You don't have permission to apply a discount or service charge." },
          { status: 403 },
        );
      }
      const resolved = resolveOrderAdjustmentsInput(body.adjustments);
      discountType = resolved.discountType;
      discountValue = resolved.discountValue;
      discountReason = resolved.discountReason;
      serviceChargeBasisPoints = resolved.serviceChargeBasisPoints;
    }

    // Phase 17 — redeem loyalty points as a discount at checkout, gated
    // behind MANAGE_CUSTOMERS (the same permission the manual redemption
    // action on the Customers page already requires — this is the
    // customer's own earned balance, not a staff discretionary discount).
    // Mutually exclusive with `adjustments` supplying its own discount:
    // there's only one discount slot per order (see order-adjustments.ts),
    // so the POS UI never offers both at once, and a client that somehow
    // sent both is rejected rather than silently having one clobber the
    // other.
    let loyaltyPointsToRedeem = 0;
    if (body.loyaltyRedemption) {
      if (!customerId) {
        return NextResponse.json(
          { error: "Attach a loyalty customer to this order before redeeming points." },
          { status: 400 },
        );
      }
      if (discountType) {
        return NextResponse.json(
          {
            error: "Can't combine a manual discount with loyalty point redemption on the same order.",
          },
          { status: 400 },
        );
      }
      const canManageCustomers = await hasPermission(
        session.user.id,
        restaurantId,
        PERMISSIONS.MANAGE_CUSTOMERS,
        role,
      );
      if (!canManageCustomers) {
        return NextResponse.json(
          { error: "You don't have permission to redeem loyalty points." },
          { status: 403 },
        );
      }
      const resolution = resolveLoyaltyRedemption({
        requestedPoints: body.loyaltyRedemption.points,
        customerPointsBalance: customerLoyaltyPointsBalance,
        subtotalInPaisa: pricing.subtotalInPaisa,
      });
      if (resolution.pointsToRedeem <= 0) {
        return NextResponse.json(
          {
            error:
              "This customer doesn't have enough loyalty points to redeem, or the order total is too small.",
          },
          { status: 400 },
        );
      }
      loyaltyPointsToRedeem = resolution.pointsToRedeem;
      discountType = "flat";
      discountValue = resolution.redemptionValueInPaisa;
      discountReason = `Loyalty redemption — ${resolution.pointsToRedeem} point${resolution.pointsToRedeem === 1 ? "" : "s"}`;
    }

    const totals = computeOrderTotals({
      subtotalInPaisa: pricing.subtotalInPaisa,
      taxInPaisa: pricing.taxInPaisa,
      discountType,
      discountValue,
      serviceChargeBasisPoints,
    });

    // Same retry-on-order-number-collision pattern as the public order
    // route — the unique index on (restaurant_id, order_number) is the
    // actual guarantee, this loop just makes it seamless. A 23505 can also
    // now come from the clientRequestId unique index (a concurrent retry of
    // the same offline-queued order winning the race) — that case resolves
    // by fetching and returning the row the other request just inserted,
    // rather than endlessly retrying with a fresh order number.
    let insertedOrder: typeof orders.$inferSelect | undefined;
    let idempotentReplay = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !insertedOrder; attempt++) {
      try {
        insertedOrder = await db.transaction(async (tx) => {
          await assertTableAcceptsOrders(tx, tableId);

          const [order] = await tx
            .insert(orders)
            .values({
              restaurantId,
              branchId: branchId!,
              tableId,
              orderNumber: generateOrderNumber(timezone),
              source: "pos",
              status: "pending",
              customerName: body.customerName || null,
              customerPhone: body.customerPhone || null,
              customerId,
              notes: body.notes || null,
              clientRequestId: body.clientRequestId || null,
              subtotalInPaisa: pricing.subtotalInPaisa,
              taxInPaisa: pricing.taxInPaisa,
              discountType,
              discountValue,
              discountInPaisa: totals.discountInPaisa,
              discountReason,
              serviceChargeBasisPoints,
              serviceChargeInPaisa: totals.serviceChargeInPaisa,
              totalInPaisa: totals.totalInPaisa,
            })
            .returning();

          // Debit the redeemed points in the SAME transaction as the order
          // insert, so the two can never drift apart (a committed order
          // with points never debited, or vice versa). Only reached on the
          // attempt that actually inserts the order — a failed attempt
          // (order-number collision, retried below) rolls this back too,
          // and the idempotent-replay path never re-enters this block at
          // all, so a clientRequestId retry can't double-debit.
          if (loyaltyPointsToRedeem > 0 && customerId) {
            await recordLoyaltyTransaction(tx, {
              restaurantId,
              customerId,
              type: "redeem",
              pointsDelta: -loyaltyPointsToRedeem,
              referenceType: "order",
              referenceId: order.id,
              note: "Redeemed at POS checkout",
              recordedByUserId: session.user.id,
            });
          }

          // Perf: batched the same way as the public QR order route (see
          // that file's comment, and PERFORMANCE_AUDIT.md) — one insert for
          // every item, one insert for every addon across the whole order,
          // instead of a per-item loop that cost up to 2 round trips PER
          // cart item.
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

          await syncTableStatusFromOrders(tx, tableId);

          return order;
        });
      } catch (err) {
        lastError = err;
        // isUniqueViolation checks both err.code and err.cause.code — see
        // its doc comment for why the latter is the one that actually
        // fires here, since this throws from inside db.transaction().
        if (!isUniqueViolation(err)) throw err;
        // A unique-index collision here is either the order-number index
        // (loop again with a freshly generated number) or, if a
        // clientRequestId was supplied, possibly a concurrent duplicate
        // submission of the SAME retry racing us — check for that before
        // burning another attempt.
        if (body.clientRequestId) {
          const raceRows = await db
            .select()
            .from(orders)
            .where(
              and(
                eq(orders.restaurantId, restaurantId),
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
      return NextResponse.json({ order: insertedOrder, idempotentReplay: true }, { status: 200 });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "order.created",
      resourceType: "order",
      resourceId: insertedOrder.id,
      ipAddress: getClientIp(request),
      metadata: {
        source: "pos",
        tableId,
        totalInPaisa: insertedOrder.totalInPaisa,
        itemCount: pricing.items.length,
        loyaltyPointsRedeemed: loyaltyPointsToRedeem > 0 ? loyaltyPointsToRedeem : undefined,
      },
    });

    return NextResponse.json({ order: insertedOrder }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
