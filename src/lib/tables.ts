import "server-only";
import { and, eq, gte, lt, ne, notInArray, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import { db } from "@/db";
import { restaurantTables, orders, reservations } from "@/db/schema";
import { deriveTableStatus, type TableStatus } from "@/lib/table-status";
import { HttpError } from "@/lib/http-error";
import { restaurantStartOfDay } from "@/lib/restaurant-date";

// Orders in either of these statuses are done moving — never a transfer/
// merge target, and excluded from "how many active orders does this table
// have" everywhere in this file. Kept as one constant so transferOrderToTable
// and mergeTables can't drift on the definition of "active". Exported so
// the orders-board GET route (orders/route.ts) can use the exact same
// definition when deciding which old orders still deserve a spot on the
// live board — see that route's own comment on why "old but still active"
// must never silently expire out of it the way "old and already resolved"
// correctly does.
export const INACTIVE_ORDER_STATUSES = ["cancelled", "completed"] as const;

export class TableError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

/**
 * The single choke point that keeps a table's `status` in sync with its
 * order activity — see the derivation rules in src/lib/table-status.ts's
 * deriveTableStatus(). Called after every order create/status-change that
 * touches a table (orders route, order status route) so the floor plan
 * reflects reality without any route having to hand-roll the logic.
 *
 * Deliberately skipped when the table is currently `out_of_service` — that
 * is a manual, staff-driven state (a broken table, a fridge leak under it,
 * whatever) and order activity elsewhere should never silently clear it.
 * Also skipped for a null/undefined tableId (a takeaway order has no
 * table to update) — callers pass the order's tableId straight through and
 * this is a no-op when it's null, so nobody needs an `if (tableId)` guard
 * at every call site.
 *
 * `tx` must be the transaction handle of the enclosing order mutation —
 * the status recompute has to commit or roll back atomically with whatever
 * order change triggered it, exactly like recordStockMovement in
 * inventory.ts.
 */
export async function syncTableStatusFromOrders(
  tx: Transaction,
  tableId: string | null | undefined,
): Promise<void> {
  if (!tableId) return;

  const [current] = await tx
    .select({ status: restaurantTables.status })
    .from(restaurantTables)
    .where(eq(restaurantTables.id, tableId))
    .limit(1);
  if (!current || current.status === "out_of_service") return;

  const [counts] = await tx
    .select({
      kitchenActive: sql<string>`count(*) filter (where ${orders.status} in ('pending','confirmed','preparing','ready'))`,
      served: sql<string>`count(*) filter (where ${orders.status} = 'served')`,
      completed: sql<string>`count(*) filter (where ${orders.status} = 'completed')`,
    })
    .from(orders)
    .where(eq(orders.tableId, tableId));

  const target = deriveTableStatus({
    kitchenActive: Number(counts?.kitchenActive ?? 0),
    served: Number(counts?.served ?? 0),
    completed: Number(counts?.completed ?? 0),
  });

  if (target !== current.status) {
    await tx
      .update(restaurantTables)
      .set({ status: target, updatedAt: new Date() })
      .where(eq(restaurantTables.id, tableId));
  }
}

/**
 * Rejects attaching a new order to a table that's currently marked broken —
 * the one case syncTableStatusFromOrders() deliberately won't clear
 * automatically, so it has to be enforced going IN instead. Called from
 * both order-creation routes (staff POS and public QR) right after the
 * table is resolved. A no-op (never throws) for a null tableId.
 */
export async function assertTableAcceptsOrders(
  tx: Transaction,
  tableId: string | null | undefined,
): Promise<void> {
  if (!tableId) return;
  const [table] = await tx
    .select({ status: restaurantTables.status })
    .from(restaurantTables)
    .where(eq(restaurantTables.id, tableId))
    .limit(1);
  if (table?.status === "out_of_service") {
    throw new TableError("This table is marked out of service and can't accept new orders.");
  }
}

/**
 * Reservation -> table status effects. A reservation only ever CLAIMS a
 * table's status when the table is currently `available` (so a reservation
 * for later tonight never overwrites the fact the table is actively
 * occupied by a walk-in right now) — the reservation itself still shows on
 * the reservation board regardless, this only controls the floor-plan tile.
 */
export async function markTableReservedIfAvailable(
  tx: Transaction,
  tableId: string,
): Promise<void> {
  await tx
    .update(restaurantTables)
    .set({ status: "reserved", updatedAt: new Date() })
    .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.status, "available")));
}

/**
 * A reservation's party has physically arrived — always claims the table as
 * occupied (a manager confirming someone is standing at the table takes
 * precedence over whatever the derived order-based status said), UNLESS
 * it's out_of_service, which stays a manual-only release.
 */
export async function markTableSeated(tx: Transaction, tableId: string): Promise<void> {
  await tx
    .update(restaurantTables)
    .set({ status: "occupied", updatedAt: new Date() })
    .where(and(eq(restaurantTables.id, tableId), ne(restaurantTables.status, "out_of_service")));
}

/**
 * A reservation that was HOLDING a table (cancelled/no_show) releases it —
 * but only back to available, and only if nothing else has since claimed
 * the table (still `reserved`, and no OTHER active reservation is holding
 * it for later the same day). If the table has moved on to occupied/
 * payment_pending/etc. in the meantime, or another reservation still needs
 * it, this is a no-op — releasing it would be wrong in both cases.
 */
export async function releaseTableIfSoleReservation(
  tx: Transaction,
  tableId: string,
  excludingReservationId: string,
  // P0-6 re-audit: this used to compute "today" via `new Date();
  // setHours(0,0,0,0)` — the APP SERVER's local midnight, not the
  // restaurant's. Node processes in this deployment run in UTC, so for
  // roughly 5h45m after real Kathmandu midnight (until the server's own
  // UTC midnight caught up), this window was silently checking the WRONG
  // calendar day — exactly the Task #130 bug class, just in a call site
  // that Task #130's original pass missed. Optional + defaulting to the
  // Asia/Kathmandu fallback (restaurantStartOfDay's own default) rather
  // than required, so any caller that hasn't been updated yet still gets
  // the CORRECT default timezone instead of silently reverting to
  // UTC-server-local.
  timezone?: string | null,
): Promise<void> {
  const dayStart = restaurantStartOfDay(timezone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const otherActive = await tx
    .select({ id: reservations.id })
    .from(reservations)
    .where(
      and(
        eq(reservations.tableId, tableId),
        ne(reservations.id, excludingReservationId),
        gte(reservations.reservationTime, dayStart),
        lt(reservations.reservationTime, dayEnd),
        sql`${reservations.status} in ('requested','confirmed')`,
      ),
    )
    .limit(1);
  if (otherActive.length > 0) return;

  await tx
    .update(restaurantTables)
    .set({ status: "available", updatedAt: new Date() })
    .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.status, "reserved")));
}

/**
 * Server-side double-booking prevention (QA-audit finding: a schema comment
 * previously claimed a "soft UI warning" existed for this — it didn't; two
 * reservations really could be booked for the same table at overlapping
 * times). Two reservations overlap when their [reservationTime,
 * reservationTime + durationMinutes) windows intersect. Cancelled/no_show
 * reservations never hold a table, so they're excluded from the check.
 *
 * Call this from inside a transaction that has already taken a row lock on
 * the table (see requireTableRowLock below) — otherwise two concurrent
 * requests booking the same table/time can both pass this check before
 * either commits.
 */
export async function assertNoReservationOverlap(
  tx: Transaction,
  params: {
    restaurantId: string;
    tableId: string;
    reservationTime: Date;
    durationMinutes: number;
    excludingReservationId?: string;
  },
): Promise<void> {
  const startsAt = params.reservationTime;
  const endsAt = new Date(startsAt.getTime() + params.durationMinutes * 60_000);

  const rows = await tx
    .select({
      id: reservations.id,
      reservationTime: reservations.reservationTime,
      durationMinutes: reservations.durationMinutes,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.restaurantId, params.restaurantId),
        eq(reservations.tableId, params.tableId),
        sql`${reservations.status} in ('requested','confirmed','seated')`,
        params.excludingReservationId ? ne(reservations.id, params.excludingReservationId) : undefined,
      ),
    );

  const conflict = rows.find((row) => {
    const otherStart = row.reservationTime.getTime();
    const otherEnd = otherStart + row.durationMinutes * 60_000;
    return startsAt.getTime() < otherEnd && otherStart < endsAt.getTime();
  });

  if (conflict) {
    throw new TableError(
      "This table already has another reservation that overlaps this time. Choose a different table or time.",
      409,
    );
  }
}

/**
 * Row-locks the table for the duration of the enclosing transaction so two
 * concurrent reservation requests against the same table serialize instead
 * of both passing assertNoReservationOverlap() before either commits — same
 * FOR UPDATE pattern the QA hardening pass used for the payments/refunds
 * races. Returns the locked row (capacity included, for the party-size
 * check callers do right after locking).
 */
export async function requireTableRowLock(
  tx: Transaction,
  restaurantId: string,
  tableId: string,
): Promise<{ id: string; capacity: number | null; branchId: string; status: TableStatus }> {
  const rows = await tx
    .select({
      id: restaurantTables.id,
      capacity: restaurantTables.capacity,
      branchId: restaurantTables.branchId,
      status: restaurantTables.status,
    })
    .from(restaurantTables)
    .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
    .for("update")
    .limit(1);
  const table = rows[0];
  if (!table) {
    throw new TableError("Table not found.", 404);
  }
  return table as { id: string; capacity: number | null; branchId: string; status: TableStatus };
}

/** Soft capacity check — only enforced when the table has a capacity set. */
export function assertPartyFitsCapacity(capacity: number | null, partySize: number): void {
  if (capacity !== null && partySize > capacity) {
    throw new TableError(
      `This table seats ${capacity}, but the party is ${partySize}. Choose a larger table or split the party.`,
    );
  }
}

/**
 * Returns today's upcoming (requested/confirmed) reservations for a set of
 * tables, keyed by tableId — used by the floor plan to show a "Reserved
 * 7:30 PM" badge on a table even when its live `status` reflects something
 * else (e.g. still occupied by an earlier walk-in). Deliberately separate
 * from the `status` column itself — see the schema comment on
 * markTableReservedIfAvailable for why reservations don't always own the
 * status field.
 */
export async function getTodayUpcomingReservationsByTable(
  restaurantId: string,
  tableIds: string[],
  // P0-6 re-audit: same server-local-midnight bug as
  // releaseTableIfSoleReservation above — see that function's comment.
  // Optional + defaulting to restaurantStartOfDay's own Asia/Kathmandu
  // fallback so a not-yet-updated caller still gets the right default
  // instead of reverting to UTC-server-local.
  timezone?: string | null,
): Promise<Map<string, { id: string; customerName: string; partySize: number; reservationTime: Date }[]>> {
  const byTable = new Map<
    string,
    { id: string; customerName: string; partySize: number; reservationTime: Date }[]
  >();
  if (tableIds.length === 0) return byTable;

  const dayStart = restaurantStartOfDay(timezone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const rows = await db.query.reservations.findMany({
    where: (r, { and: qAnd, eq: qEq, gte: qGte, lt: qLt, inArray, sql: qSql }) =>
      qAnd(
        qEq(r.restaurantId, restaurantId),
        inArray(r.tableId, tableIds),
        qGte(r.reservationTime, dayStart),
        qLt(r.reservationTime, dayEnd),
        qSql`${r.status} in ('requested','confirmed')`,
      ),
    orderBy: (r, { asc }) => [asc(r.reservationTime)],
  });

  for (const row of rows) {
    if (!row.tableId) continue;
    const list = byTable.get(row.tableId) ?? [];
    list.push({
      id: row.id,
      customerName: row.customerName,
      partySize: row.partySize,
      reservationTime: row.reservationTime,
    });
    byTable.set(row.tableId, list);
  }
  return byTable;
}

// ---------------------------------------------------------------------------
// Commercial Launch Phase B.7 — Table Operations (transfer / merge / hold /
// resume). `orders.tableId` is a plain nullable FK that, until this phase,
// no route ever mutated after order creation — PHASE_12_NOTES.md flagged
// this as a deliberately deferred, straightforward addition: update
// tableId, then re-sync both tables' derived status in the same
// transaction. That's exactly what transferOrderToTable/mergeTables do
// below; no schema change was needed for either.
// ---------------------------------------------------------------------------

/**
 * Moves ONE order onto a different table. Row-locks both the order and the
 * destination table for the duration of the transaction (same FOR UPDATE
 * discipline as requireTableRowLock's own doc comment), rejects a
 * cancelled/completed order (nothing left to move) and a destination
 * that's out_of_service (reusing the same rule assertTableAcceptsOrders
 * enforces at order-creation time). Re-syncs BOTH the source and
 * destination table's derived status afterward — the source may drop back
 * to `available`, the destination may become `occupied`.
 */
export async function transferOrderToTable(
  tx: Transaction,
  params: { restaurantId: string; orderId: string; toTableId: string },
): Promise<{ order: typeof orders.$inferSelect; fromTableId: string | null }> {
  const orderRows = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, params.orderId), eq(orders.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  const order = orderRows[0];
  if (!order) {
    throw new TableError("Order not found.", 404);
  }
  if (INACTIVE_ORDER_STATUSES.includes(order.status as (typeof INACTIVE_ORDER_STATUSES)[number])) {
    throw new TableError("Can't transfer a cancelled or completed order.");
  }
  if (order.tableId === params.toTableId) {
    throw new TableError("This order is already on that table.");
  }

  const toTable = await requireTableRowLock(tx, params.restaurantId, params.toTableId);
  if (toTable.status === "out_of_service") {
    throw new TableError("This table is marked out of service and can't accept new orders.");
  }
  // A table is a physical fixture at one branch — an order transferred onto
  // a table in a different branch would leave orders.branchId (this
  // order's own operating branch, set at creation) disagreeing with where
  // it now physically sits, breaking every branch-scoped report/KDS/floor
  // plan query that joins the two. Cross-branch moves aren't a "transfer"
  // in any physical sense anyway.
  if (toTable.branchId !== order.branchId) {
    throw new TableError("Can't transfer an order to a table in a different branch.");
  }

  const fromTableId = order.tableId;
  const [updated] = await tx
    .update(orders)
    .set({ tableId: params.toTableId, updatedAt: new Date() })
    .where(and(eq(orders.id, params.orderId), eq(orders.restaurantId, params.restaurantId)))
    .returning();

  await syncTableStatusFromOrders(tx, fromTableId);
  await syncTableStatusFromOrders(tx, params.toTableId);

  return { order: updated, fromTableId };
}

/**
 * Batch-transfers EVERY active order from one table onto another — the
 * "these two tables just became one party" action. Built directly on
 * transferOrderToTable's own primitive (one call per active order) rather
 * than a parallel bulk-UPDATE, so a merge can never silently diverge from
 * what a single transfer does (same rejects, same per-table status
 * re-sync — the per-table sync is naturally idempotent/redundant across
 * the loop, which is fine, not a correctness issue).
 */
export async function mergeTables(
  tx: Transaction,
  params: { restaurantId: string; fromTableId: string; toTableId: string },
): Promise<{ movedOrderIds: string[] }> {
  if (params.fromTableId === params.toTableId) {
    throw new TableError("Choose two different tables to merge.");
  }

  // Lock BOTH tables — not just the source (which alone already serializes
  // two concurrent merges FROM the same table over which orders each sees
  // as "active") — and always in the same DETERMINISTIC order regardless
  // of which one is "from" and which is "to".
  //
  // QA hardening pass (Phase 8 / master prompt section 11) — locking only
  // fromTableId here, then relying on transferOrderToTable's own
  // requireTableRowLock(toTableId) inside the loop below, meant the actual
  // lock ACQUISITION order was always [fromTableId, toTableId] as the
  // caller happened to name them. Two staff members concurrently merging
  // the same pair of tables in opposite logical directions —
  // mergeTables({fromTableId: X, toTableId: Y}) racing
  // mergeTables({fromTableId: Y, toTableId: X}) — would then take the
  // locks in opposite PHYSICAL order (X-then-Y vs Y-then-X): a textbook
  // deadlock (Postgres error 40P01), with one of the two transactions
  // aborted rather than simply waiting its turn. Sorting the two table ids
  // before locking means every concurrent merge touching this same pair,
  // regardless of logical direction, always acquires the locks in the
  // same physical order — one txn always waits behind the other instead
  // of both waiting on each other.
  //
  // This does mean toTableId is now validated to exist (and locked)
  // slightly earlier than before — previously it wasn't touched until the
  // first transferOrderToTable call inside the loop below, so an invalid
  // toTableId combined with zero active orders on fromTableId used to
  // surface as "source table has no active orders" instead of "table not
  // found". Both are still TableError instances with sensible messages;
  // failing on the more fundamental problem (destination table doesn't
  // exist) first is, if anything, the more correct order — not a
  // regression this fix should avoid.
  const [firstTableId, secondTableId] =
    params.fromTableId < params.toTableId
      ? [params.fromTableId, params.toTableId]
      : [params.toTableId, params.fromTableId];
  await requireTableRowLock(tx, params.restaurantId, firstTableId);
  await requireTableRowLock(tx, params.restaurantId, secondTableId);

  const activeOrders = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, params.restaurantId),
        eq(orders.tableId, params.fromTableId),
        notInArray(orders.status, [...INACTIVE_ORDER_STATUSES]),
      ),
    );
  if (activeOrders.length === 0) {
    throw new TableError("The source table has no active orders to merge.");
  }

  const movedOrderIds: string[] = [];
  for (const row of activeOrders) {
    await transferOrderToTable(tx, {
      restaurantId: params.restaurantId,
      orderId: row.id,
      toTableId: params.toTableId,
    });
    movedOrderIds.push(row.id);
  }

  return { movedOrderIds };
}

/**
 * Pauses an order's forward progress — see the isOnHold column's own doc
 * comment in schema.ts for why this is an orthogonal flag rather than a
 * new `status` value. Idempotent-safe: holding an already-held order just
 * overwrites the reason/timestamp rather than erroring, since two staff
 * members hitting "hold" moments apart shouldn't surface a conflict.
 */
export async function holdOrder(
  tx: Transaction,
  params: { restaurantId: string; orderId: string; userId: string; reason?: string | null },
): Promise<typeof orders.$inferSelect> {
  const orderRows = await tx
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, params.orderId), eq(orders.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  const order = orderRows[0];
  if (!order) {
    throw new TableError("Order not found.", 404);
  }
  if (INACTIVE_ORDER_STATUSES.includes(order.status as (typeof INACTIVE_ORDER_STATUSES)[number])) {
    throw new TableError("Can't hold a cancelled or completed order.");
  }

  const [updated] = await tx
    .update(orders)
    .set({
      isOnHold: true,
      heldAt: new Date(),
      heldByUserId: params.userId,
      holdReason: params.reason ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(orders.id, params.orderId), eq(orders.restaurantId, params.restaurantId)))
    .returning();
  return updated;
}

/** The symmetric inverse of holdOrder — clears all four hold columns. A safe no-op-but-returns-row if the order wasn't on hold. */
export async function resumeOrder(
  tx: Transaction,
  params: { restaurantId: string; orderId: string },
): Promise<typeof orders.$inferSelect> {
  const orderRows = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, params.orderId), eq(orders.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  if (!orderRows[0]) {
    throw new TableError("Order not found.", 404);
  }

  const [updated] = await tx
    .update(orders)
    .set({
      isOnHold: false,
      heldAt: null,
      heldByUserId: null,
      holdReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(orders.id, params.orderId), eq(orders.restaurantId, params.restaurantId)))
    .returning();
  return updated;
}
