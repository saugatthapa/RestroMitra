/**
 * Integration test for the P0-8 fix: the clock-in route
 * (src/app/api/restaurants/[slug]/attendance/clock-in/route.ts) used to
 * guard "at most one open shift per user" with a plain SELECT-then-INSERT
 * — no locking, no DB-level backstop, a gap the route's own prior comment
 * self-documented. Two clock-in requests from the same user close enough
 * together (a double-tap, or a flaky-connection retry re-sending the same
 * clock-in) could both pass the SELECT before either INSERT committed,
 * opening two simultaneous "open" shifts for one user.
 *
 * The fix adds `attendance_records_one_open_shift_per_user_unique` — a
 * partial unique index on (user_id, restaurant_id) WHERE clock_out_at IS
 * NULL — so the invariant holds at the database level regardless of
 * application timing. This proves the constraint directly (two open-shift
 * inserts for the same user), the genuinely-concurrent variant, and that
 * it does NOT over-constrain (closed shifts don't count; different users
 * and different restaurants are independent).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, isNull } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("attendance_records_one_open_shift_per_user_unique (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let isUniqueViolation: typeof import("@/lib/db-error").isUniqueViolation;

  let restaurantAId: string;
  let restaurantBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    isUniqueViolation = (await import("@/lib/db-error")).isUniqueViolation;

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-attendance-race-a-${suffix}`, name: "TEST Attendance Race Restaurant A" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;

    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-attendance-race-b-${suffix}`, name: "TEST Attendance Race Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantBId = restaurantB.id;
  });

  afterAll(async () => {
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantAId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.fullName, "TEST Attendance Race User"));
  });

  async function createUser() {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Attendance Race User", phone: `97${suffix.slice(0, 8)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    return user.id;
  }

  async function clockIn(userId: string, restaurantId: string, clockOutAt: Date | null = null) {
    return db
      .insert(schema.attendanceRecords)
      .values({ restaurantId, userId, clockOutAt })
      .returning();
  }

  it("rejects a second open shift for the same user at the same restaurant", async () => {
    const userId = await createUser();
    await clockIn(userId, restaurantAId);

    await expect(clockIn(userId, restaurantAId)).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err),
    );
  });

  it("allows a new shift once the user's prior shift is clocked out", async () => {
    const userId = await createUser();
    await clockIn(userId, restaurantAId, new Date());

    const [created] = await clockIn(userId, restaurantAId);
    expect(created.clockOutAt).toBeNull();
  });

  it("does not constrain different users from each other", async () => {
    const userA = await createUser();
    const userB = await createUser();
    await clockIn(userA, restaurantAId);
    const [createdB] = await clockIn(userB, restaurantAId);
    expect(createdB.userId).toBe(userB);
  });

  it("does not constrain the same user across different restaurants", async () => {
    const userId = await createUser();
    await clockIn(userId, restaurantAId);
    const [createdAtB] = await clockIn(userId, restaurantBId);
    expect(createdAtB.restaurantId).toBe(restaurantBId);
  });

  it("under genuine concurrency, exactly one of two simultaneous clock-ins for the same user wins", async () => {
    const userId = await createUser();
    const attempt = () =>
      clockIn(userId, restaurantAId)
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const failure = failed[0] as { ok: false; err: unknown };
    expect(isUniqueViolation(failure.err)).toBe(true);

    const openShifts = await db.query.attendanceRecords.findMany({
      where: and(
        eq(schema.attendanceRecords.userId, userId),
        eq(schema.attendanceRecords.restaurantId, restaurantAId),
        isNull(schema.attendanceRecords.clockOutAt),
      ),
    });
    // Exactly one open shift, no matter how the race landed.
    expect(openShifts).toHaveLength(1);
  });
});
