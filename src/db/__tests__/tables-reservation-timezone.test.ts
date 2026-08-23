/**
 * P0-6 re-audit regression test: two helpers in src/lib/tables.ts —
 * releaseTableIfSoleReservation and getTodayUpcomingReservationsByTable —
 * used to compute "today" via `new Date(); setHours(0, 0, 0, 0)`, which is
 * the APP SERVER's local midnight, not the restaurant's. This is exactly
 * the Task #130 bug class (see restaurant-date.ts's module doc comment):
 * for roughly 5h45m every day (the gap between real Kathmandu midnight and
 * the server's own UTC midnight), these two functions were silently
 * bucketing reservations into the WRONG calendar day — missed by Task
 * #130's original pass since it isn't one of the call sites that already
 * says "today" out loud.
 *
 * The fix threads an optional `timezone` param through both functions,
 * using restaurantStartOfDay() (the same utility every other day-boundary
 * call site in the app now uses) instead of server-local midnight.
 *
 * Rather than hardcoding a specific real-world date/time (these functions
 * always compute relative to actual "now", with no injectable clock), this
 * test derives — AT RUN TIME, from whatever moment the test happens to
 * execute — a reservation instant that falls inside the CORRECT
 * (Kathmandu-timezone) "today" window but outside the OLD BUGGY
 * (server-local midnight) "today" window, then proves the real exported
 * functions land on the correct side of that boundary. This makes the test
 * deterministically meaningful no matter when it runs, since Nepal's
 * UTC+5:45 offset from the app server's own local time never changes
 * (Nepal observes no DST).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("tables.ts reservation day-window uses restaurant timezone (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let tablesLib: typeof import("@/lib/tables");
  let restaurantDateLib: typeof import("@/lib/restaurant-date");

  let restaurantId: string;
  let branchId: string;

  const TIMEZONE = "Asia/Kathmandu";

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    tablesLib = await import("@/lib/tables");
    restaurantDateLib = await import("@/lib/restaurant-date");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tz-reservation-${suffix}`, name: "TEST TZ Reservation Restaurant", timezone: TIMEZONE })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;
  });

  afterAll(async () => {
    await db.delete(schema.reservations).where(eq(schema.reservations.restaurantId, restaurantId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function createTable() {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [table] = await db
      .insert(schema.restaurantTables)
      .values({ restaurantId, branchId, name: `TEST Table ${suffix}`, qrToken: `test-qr-${suffix}` })
      .returning();
    return table;
  }

  /**
   * A reservationTime instant that's inside restaurantStartOfDay(TIMEZONE)'s
   * "today" window but OUTSIDE the old buggy `new Date();
   * setHours(0,0,0,0)` server-local "today" window — see this file's
   * module doc comment for the derivation. Also self-checks its own
   * derivation so a broken assumption fails loudly instead of silently
   * testing nothing.
   */
  function boundaryStraddlingInstant(): Date {
    const fixedStart = restaurantDateLib.restaurantStartOfDay(TIMEZONE);
    const fixedEnd = new Date(fixedStart.getTime() + 24 * 60 * 60 * 1000);

    const buggyStart = new Date();
    buggyStart.setHours(0, 0, 0, 0);
    const buggyEnd = new Date(buggyStart.getTime() + 24 * 60 * 60 * 1000);

    const candidate =
      fixedStart.getTime() < buggyStart.getTime()
        ? new Date(fixedStart.getTime() + 60_000) // just after Kathmandu midnight
        : new Date(fixedEnd.getTime() - 60_000); // just before Kathmandu's day ends

    // Self-check: candidate must be inside the CORRECT window...
    expect(candidate.getTime()).toBeGreaterThanOrEqual(fixedStart.getTime());
    expect(candidate.getTime()).toBeLessThan(fixedEnd.getTime());
    // ...and OUTSIDE the OLD BUGGY window — this is the exact instant the
    // pre-fix code would have miscategorized as "not today."
    const insideBuggyWindow = candidate.getTime() >= buggyStart.getTime() && candidate.getTime() < buggyEnd.getTime();
    expect(insideBuggyWindow).toBe(false);

    return candidate;
  }

  it("getTodayUpcomingReservationsByTable finds a reservation inside the restaurant's timezone window even when the server-local window would have missed it", async () => {
    const table = await createTable();
    const reservationTime = boundaryStraddlingInstant();

    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        restaurantId,
        branchId,
        tableId: table.id,
        customerName: "TEST Boundary Guest",
        customerPhone: "9800000001",
        partySize: 2,
        reservationTime,
        status: "confirmed",
      })
      .returning();

    const byTable = await tablesLib.getTodayUpcomingReservationsByTable(restaurantId, [table.id], TIMEZONE);
    const found = byTable.get(table.id) ?? [];
    expect(found.some((r) => r.id === reservation.id)).toBe(true);
  });

  it("releaseTableIfSoleReservation refuses to release a table still held by a same-restaurant-day reservation the server-local window would have missed", async () => {
    const table = await createTable();
    const reservationTime = boundaryStraddlingInstant();

    // The blocking reservation — still active, sitting at the boundary
    // instant that only the CORRECT (restaurant-timezone) window sees.
    await db.insert(schema.reservations).values({
      restaurantId,
      branchId,
      tableId: table.id,
      customerName: "TEST Blocking Guest",
      customerPhone: "9800000002",
      partySize: 2,
      reservationTime,
      status: "confirmed",
    });

    // The reservation actually being cancelled/released.
    const [releasing] = await db
      .insert(schema.reservations)
      .values({
        restaurantId,
        branchId,
        tableId: table.id,
        customerName: "TEST Releasing Guest",
        customerPhone: "9800000003",
        partySize: 2,
        reservationTime: new Date(),
        status: "no_show",
      })
      .returning();

    await db
      .update(schema.restaurantTables)
      .set({ status: "reserved" })
      .where(eq(schema.restaurantTables.id, table.id));

    await db.transaction((tx) => tablesLib.releaseTableIfSoleReservation(tx, table.id, releasing.id, TIMEZONE));

    const [afterTable] = await db.select().from(schema.restaurantTables).where(eq(schema.restaurantTables.id, table.id));
    // Must NOT have been released — the blocking reservation is still
    // "today" for this restaurant's actual timezone, even though the old
    // server-local computation would have missed it and released the
    // table right out from under that booking.
    expect(afterTable.status).toBe("reserved");
  });
});
