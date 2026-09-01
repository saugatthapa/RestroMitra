import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables, restaurants, serviceCalls } from "@/db/schema";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { publishEvent } from "@/lib/realtime";
import { sendPushToRestaurant } from "@/lib/push";
import { isUniqueViolation } from "@/lib/db-error";

const ACTIVE_STATUSES = ["pending", "acknowledged"] as const;

async function resolveTable(token: string) {
  const rows = await db
    .select({
      tableId: restaurantTables.id,
      tableName: restaurantTables.name,
      branchId: restaurantTables.branchId,
      tableIsActive: restaurantTables.isActive,
      restaurantId: restaurants.id,
      restaurantIsActive: restaurants.isActive,
    })
    .from(restaurantTables)
    .innerJoin(restaurants, eq(restaurantTables.restaurantId, restaurants.id))
    .where(eq(restaurantTables.qrToken, token))
    .limit(1);
  const resolved = rows[0];
  if (!resolved || !resolved.tableIsActive || !resolved.restaurantIsActive) return null;
  return resolved;
}

function serializeCall(call: typeof serviceCalls.$inferSelect) {
  return {
    id: call.id,
    status: call.status,
    createdAt: call.createdAt,
    acknowledgedAt: call.acknowledgedAt,
    resolvedAt: call.resolvedAt,
  };
}

/**
 * Public, UNAUTHENTICATED — the "Call staff" button on the QR menu. Same
 * trust boundary as order placement (src/app/api/order/[token]/route.ts):
 * the qrToken is the entire access control, so this is rate limited by both
 * IP and table the same way. Idempotent by design: if this table already
 * has an active (pending/acknowledged) call, that same call is returned
 * instead of creating a duplicate — a guest double-tapping (or retrying
 * after a flaky connection) doesn't spawn a second alert on staff screens.
 *
 * The SELECT-then-INSERT below is a plain read-then-write with no locking,
 * so it's only a best-effort check on its own — two requests for the same
 * table close enough together (a double-tap fast enough to beat one round
 * trip, or two retries from a flaky connection) can both pass the SELECT
 * before either INSERT commits. The actual guarantee is the
 * `service_calls_one_active_per_table_unique` partial unique index (see
 * schema.ts): the loser of that race gets a 23505 back from Postgres, which
 * is caught below and turned into the same "return the existing call"
 * response the SELECT path takes — so a guest never sees an error, and
 * staff never see a duplicate alert, no matter how the race lands.
 */
export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { token } = await ctx.params;

    const ip = getClientIp(request) ?? "unknown";
    const ipLimit = await rateLimit(`service-call:ip:${ip}`, { limit: 10, windowMs: 10 * 60 * 1000 });
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }
    const tokenLimit = await rateLimit(`service-call:token:${token}`, {
      limit: 6,
      windowMs: 10 * 60 * 1000,
    });
    if (!tokenLimit.allowed) {
      return NextResponse.json(
        { error: "Staff have already been called for this table. Please wait a moment." },
        { status: 429 },
      );
    }

    const resolved = await resolveTable(token);
    if (!resolved) {
      return NextResponse.json(
        { error: "This table is not available right now." },
        { status: 404 },
      );
    }

    const existing = await db.query.serviceCalls.findFirst({
      where: and(
        eq(serviceCalls.tableId, resolved.tableId),
        inArray(serviceCalls.status, ACTIVE_STATUSES),
      ),
      orderBy: (sc, { desc }) => [desc(sc.createdAt)],
    });
    if (existing) {
      return NextResponse.json({ call: serializeCall(existing) }, { status: 200 });
    }

    let created: typeof serviceCalls.$inferSelect;
    try {
      const [inserted] = await db
        .insert(serviceCalls)
        .values({
          restaurantId: resolved.restaurantId,
          branchId: resolved.branchId,
          tableId: resolved.tableId,
          status: "pending",
        })
        .returning();
      created = inserted;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost the race against a concurrent request for the same table — the
      // other request's insert is the one that landed. Fetch it and return
      // it the same way the up-front SELECT would have, rather than
      // erroring out or creating a duplicate.
      const raceWinner = await db.query.serviceCalls.findFirst({
        where: and(
          eq(serviceCalls.tableId, resolved.tableId),
          inArray(serviceCalls.status, ACTIVE_STATUSES),
        ),
        orderBy: (sc, { desc }) => [desc(sc.createdAt)],
      });
      if (!raceWinner) {
        // Should be unreachable — the unique index only fires when an
        // active row exists — but don't silently swallow the original
        // error if reality disagrees.
        throw err;
      }
      return NextResponse.json({ call: serializeCall(raceWinner) }, { status: 200 });
    }

    await publishEvent(db, {
      restaurantId: resolved.restaurantId,
      branchId: resolved.branchId,
      type: "service_call.created",
      payload: {
        callId: created.id,
        tableId: resolved.tableId,
        tableName: resolved.tableName,
        status: created.status,
        createdAt: created.createdAt.toISOString(),
      },
    });

    await recordAuditLog({
      restaurantId: resolved.restaurantId,
      userId: null,
      action: "service_call.created",
      resourceType: "service_call",
      resourceId: created.id,
      ipAddress: getClientIp(request),
      metadata: { tableId: resolved.tableId, tableName: resolved.tableName },
    });

    // Same reasoning as order creation (see api/order/[token]/route.ts) —
    // the SSE publish above only reaches an already-open dashboard tab;
    // this is what reaches staff whose phone/app is fully closed. A guest
    // tapping "call staff" and getting no response because everyone's
    // screen happened to be off was exactly as real a gap as the missing
    // order alert was, just never wired up when Web Push was first added.
    // P0-4: scoped to this table's own branch — a branch-restricted staff
    // member at a DIFFERENT branch of this restaurant must not be paged
    // for a table that isn't theirs. Unrestricted staff (owner/manager)
    // still get it regardless of branch — see sendPushToRestaurant's doc
    // comment.
    void sendPushToRestaurant(
      resolved.restaurantId,
      {
        title: "Table needs help",
        body: `${resolved.tableName} is calling staff`,
        url: "/dashboard/tables",
        tag: "restromitra-service-call",
      },
      resolved.branchId,
    );

    return NextResponse.json({ call: serializeCall(created) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Lets the guest's own screen poll for the status of their table's active
 * call ("Staff have been notified" -> "On the way" -> disappears once
 * resolved). Deliberately a plain short-poll endpoint (the client polls
 * this every few seconds) rather than a second SSE stream: the guest only
 * ever needs to know about ONE call — their own — so there's nothing a
 * push channel buys here that a 3s poll doesn't already deliver
 * imperceptibly fast for a "someone's coming" status line. The SSE budget
 * is spent where it matters operationally: the staff-side stream (see
 * src/app/api/restaurants/[slug]/events/route.ts), which fans a single
 * event out to every staff screen at once and is what the kitchen/counter/
 * waiter alerting actually depends on.
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const resolved = await resolveTable(token);
    if (!resolved) {
      return NextResponse.json(
        { error: "This table is not available right now." },
        { status: 404 },
      );
    }

    const existing = await db.query.serviceCalls.findFirst({
      where: and(
        eq(serviceCalls.tableId, resolved.tableId),
        inArray(serviceCalls.status, ACTIVE_STATUSES),
      ),
      orderBy: (sc, { desc }) => [desc(sc.createdAt)],
    });

    return NextResponse.json({ call: existing ? serializeCall(existing) : null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
