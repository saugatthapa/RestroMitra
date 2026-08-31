/**
 * Phase 16 (Attendance overhaul, Track B — Analytics & payroll integration)
 * — integration tests for attendance-analytics-db.ts's getAttendanceAnalytics,
 * end to end against real Postgres. Unlike most of this project's other
 * *-db.ts modules, this one has no cookies()/resolveRestaurantContext
 * dependency of its own, so (unlike the route it backs) it can be called
 * directly here rather than only having its underlying query SHAPES
 * proven — same reason scheduling-db.ts's matchScheduleWithAttendance is
 * tested directly rather than just via query-shape assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);
const TZ = "UTC";

describe.skipIf(!hasDb)("getAttendanceAnalytics (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let getAttendanceAnalytics: typeof import("@/lib/attendance-analytics-db").getAttendanceAnalytics;

  let restaurantId: string;
  let branchAId: string;
  let branchBId: string;
  let userAId: string; // scoped to branch A
  let userBId: string; // scoped to branch B
  let inactiveUserId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ({ getAttendanceAnalytics } = await import("@/lib/attendance-analytics-db"));

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-attn-analytics-${suffix}`, name: "TEST Attendance Analytics Restaurant", timezone: TZ })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch A" })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch B" })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [userA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Analytics Alice", phone: `9761${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userAId = userA.id;

    const [userB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Analytics Bob", phone: `9762${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userBId = userB.id;

    const [inactiveUser] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Analytics Former", phone: `9763${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    inactiveUserId = inactiveUser.id;

    await db.insert(schema.userRoles).values([
      { userId: userAId, restaurantId, branchId: branchAId, role: "waiter", isActive: true },
      { userId: userBId, restaurantId, branchId: branchBId, role: "waiter", isActive: true },
      { userId: inactiveUserId, restaurantId, role: "waiter", isActive: false },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.restaurantId, restaurantId));
    await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.restaurantId, restaurantId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userAId));
    await db.delete(schema.users).where(eq(schema.users.id, userBId));
    await db.delete(schema.users).where(eq(schema.users.id, inactiveUserId));
  });

  it("returns an empty array when the restaurant has no active staff at all", async () => {
    const emptyRestaurant = await db
      .insert(schema.restaurants)
      .values({ slug: `test-attn-analytics-empty-${Math.random().toString(36).slice(2, 8)}`, name: "TEST Empty" })
      .returning({ id: schema.restaurants.id });
    const result = await getAttendanceAnalytics(emptyRestaurant[0].id, "2026-08-01", "2026-08-31", TZ, null);
    expect(result).toEqual([]);
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, emptyRestaurant[0].id));
  });

  it("gives every active staff member a row, even one with zero activity in the period — never omits one", async () => {
    const result = await getAttendanceAnalytics(restaurantId, "2026-08-01", "2026-08-31", TZ, null);
    expect(result.map((r) => r.userId).sort()).toEqual([userAId, userBId].sort());
    // The inactive (deactivated) staff member must NOT appear at all.
    expect(result.some((r) => r.userId === inactiveUserId)).toBe(false);
    for (const row of result) {
      expect(row.totalMinutes).toBe(0);
      expect(row.daysPresent).toBe(0);
      expect(row.scheduledShiftsCount).toBe(0);
    }
  });

  it("excludes rejected attendance from worked-time figures but still counts it as rejectedShiftsCount", async () => {
    await db.insert(schema.attendanceRecords).values([
      { restaurantId, userId: userAId, clockInAt: new Date("2026-09-01T09:00:00Z"), clockOutAt: new Date("2026-09-01T17:00:00Z"), status: "verified" },
      { restaurantId, userId: userAId, clockInAt: new Date("2026-09-02T09:00:00Z"), clockOutAt: new Date("2026-09-02T17:00:00Z"), status: "rejected" },
    ]);

    const result = await getAttendanceAnalytics(restaurantId, "2026-09-01", "2026-09-30", TZ, null);
    const alice = result.find((r) => r.userId === userAId)!;
    expect(alice.daysPresent).toBe(1);
    expect(alice.totalMinutes).toBe(480);
    expect(alice.rejectedShiftsCount).toBe(1);

    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
  });

  it("folds approved, non-unpaid leave into paidLeaveDays, clipped to the period, excluding unpaid/pending", async () => {
    await db.insert(schema.leaveRequests).values([
      { restaurantId, userId: userAId, leaveType: "sick", status: "approved", startDate: "2026-10-05", endDate: "2026-10-06" },
      { restaurantId, userId: userAId, leaveType: "unpaid", status: "approved", startDate: "2026-10-10", endDate: "2026-10-10" },
      { restaurantId, userId: userAId, leaveType: "casual", status: "pending", startDate: "2026-10-15", endDate: "2026-10-15" },
    ]);

    const result = await getAttendanceAnalytics(restaurantId, "2026-10-01", "2026-10-31", TZ, null);
    const alice = result.find((r) => r.userId === userAId)!;
    expect(alice.paidLeaveDays).toBe(2);

    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userAId));
  });

  it("computes scheduledShiftsCount/completedShiftsCount/noShowCount/lateCount from real matched shifts", async () => {
    // Both shifts are dated safely in the past (relative to the real clock)
    // so a genuine no-show — nothing ever clocked in, and `now` already
    // past the planned end — actually resolves to ScheduleStatus
    // "no_show" rather than "upcoming"/"in_progress" (computeScheduleVariance
    // compares the planned end against the REAL current instant since
    // getAttendanceAnalytics doesn't pin a `now`, matching its "live
    // dashboard" semantics).
    //
    // A completed, 15-minutes-late shift.
    await db.insert(schema.scheduledShifts).values({
      restaurantId,
      userId: userAId,
      shiftDate: "2026-01-02",
      plannedStartAt: new Date("2026-01-02T09:00:00Z"),
      plannedEndAt: new Date("2026-01-02T17:00:00Z"),
    });
    await db.insert(schema.attendanceRecords).values({
      restaurantId,
      userId: userAId,
      clockInAt: new Date("2026-01-02T09:20:00Z"), // 20 min late - 5 min grace = 15
      clockOutAt: new Date("2026-01-02T17:00:00Z"),
      status: "verified",
    });
    // A no-show shift — nothing clocked in.
    await db.insert(schema.scheduledShifts).values({
      restaurantId,
      userId: userAId,
      shiftDate: "2026-01-03",
      plannedStartAt: new Date("2026-01-03T09:00:00Z"),
      plannedEndAt: new Date("2026-01-03T17:00:00Z"),
    });

    const result = await getAttendanceAnalytics(restaurantId, "2026-01-01", "2026-01-31", TZ, null);
    const alice = result.find((r) => r.userId === userAId)!;
    expect(alice.scheduledShiftsCount).toBe(2);
    expect(alice.completedShiftsCount).toBe(1);
    expect(alice.noShowCount).toBe(1);
    expect(alice.lateCount).toBe(1);
    expect(alice.totalLateMinutes).toBe(15);

    await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.userId, userAId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
  });

  it("branch scoping: a specific branchId returns only that branch's staff plus restaurant-wide (unscoped) staff", async () => {
    const branchAOnly = await getAttendanceAnalytics(restaurantId, "2026-08-01", "2026-08-31", TZ, branchAId);
    expect(branchAOnly.map((r) => r.userId)).toEqual([userAId]);

    const branchBOnly = await getAttendanceAnalytics(restaurantId, "2026-08-01", "2026-08-31", TZ, branchBId);
    expect(branchBOnly.map((r) => r.userId)).toEqual([userBId]);

    const unscoped = await getAttendanceAnalytics(restaurantId, "2026-08-01", "2026-08-31", TZ, null);
    expect(unscoped.map((r) => r.userId).sort()).toEqual([userAId, userBId].sort());
  });
});
