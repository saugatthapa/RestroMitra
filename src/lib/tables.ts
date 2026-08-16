import "server-only";
import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import { db } from "@/db";
import { restaurantTables, orders, reservations } from "@/db/schema";
import { deriveTableStatus, type TableStatus } from "@/lib/table-status";
import { HttpError } from "@/lib/http-error";

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
): Promise<void> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
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
): Promise<Map<string, { id: string; customerName: string; partySize: number; reservationTime: Date }[]>> {
  const byTable = new Map<
    string,
    { id: string; customerName: string; partySize: number; reservationTime: Date }[]
  >();
  if (tableIds.length === 0) return byTable;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
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
