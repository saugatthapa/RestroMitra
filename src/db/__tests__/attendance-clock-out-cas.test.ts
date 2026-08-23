/**
 * RC audit P2 regression test: proves the compare-and-swap guard added to
 * the clock-out route (src/app/api/restaurants/[slug]/attendance/clock-out/
 * route.ts) — `WHERE id = ? AND clock_out_at IS NULL` — actually prevents a
 * double-tap (or any two racing clock-out requests for the same shift) from
 * overwriting an already-recorded clockOutAt with a later timestamp.
 *
 * Exercises the identical WHERE-clause shape the route now uses, same
 * approach as reservation-status-cas.test.ts (this project has no
 * established harness for mocking resolveRestaurantContext's session, so
 * this proves the SQL-level guarantee the fix relies on directly).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Attendance clock-out CAS (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let userId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-clockout-cas-${suffix}`, name: "TEST Clock-Out CAS Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Clock-Out CAS User", phone: `9711${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;
  });

  afterAll(async () => {
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  async function openShift() {
    const [shift] = await db
      .insert(schema.attendanceRecords)
      .values({ restaurantId, userId, clockOutAt: null })
      .returning();
    return shift;
  }

  async function casClockOut(shiftId: string, at: Date) {
    return db
      .update(schema.attendanceRecords)
      .set({ clockOutAt: at })
      .where(and(eq(schema.attendanceRecords.id, shiftId), isNull(schema.attendanceRecords.clockOutAt)))
      .returning();
  }

  it("a second clock-out against an already-closed shift matches zero rows and does not overwrite the timestamp", async () => {
    const shift = await openShift();
    const firstAt = new Date("2026-08-23T10:00:00.000Z");
    const secondAt = new Date("2026-08-23T10:05:00.000Z");

    const first = await casClockOut(shift.id, firstAt);
    expect(first).toHaveLength(1);

    const second = await casClockOut(shift.id, secondAt);
    expect(second).toHaveLength(0);

    const [finalRow] = await db
      .select({ clockOutAt: schema.attendanceRecords.clockOutAt })
      .from(schema.attendanceRecords)
      .where(eq(schema.attendanceRecords.id, shift.id));
    expect(finalRow.clockOutAt?.toISOString()).toBe(firstAt.toISOString());
  });

  it("under genuine concurrency, exactly one of two simultaneous clock-outs for the same shift wins", async () => {
    const shift = await openShift();

    const [a, b] = await Promise.all([
      casClockOut(shift.id, new Date("2026-08-23T11:00:00.000Z")),
      casClockOut(shift.id, new Date("2026-08-23T11:00:01.000Z")),
    ]);
    const winners = [a, b].filter((r) => r.length === 1);
    const losers = [a, b].filter((r) => r.length === 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });
});
