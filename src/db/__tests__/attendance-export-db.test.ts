/**
 * Commercial completion pass (Data Export gap — attendance) integration
 * tests for getAttendanceExportRows() in src/lib/attendance-analytics-db.ts
 * — the per-day counterpart of getAttendanceAnalytics (see that module's
 * own test file, attendance-analytics-db.test.ts, for the same DB-fixture
 * conventions this file follows). RBAC/permission gating (MANAGE_STAFF +
 * FEATURES.STAFF_ATTENDANCE) lives in the route itself and
 * resolveRestaurantContext's own tests already cover that layer — this
 * file exercises the per-day classification (present/late/no_show/
 * on_leave/holiday), tenant isolation, and branch scoping directly.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);
const TZ = "UTC";

describe.skipIf(!hasDb)("getAttendanceExportRows (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let getAttendanceExportRows: typeof import("@/lib/attendance-analytics-db").getAttendanceExportRows;

  let restaurantId: string;
  let otherRestaurantId: string;
  let branchAId: string;
  let branchBId: string;
  let userAId: string; // scoped to branch A
  let userBId: string; // scoped to branch B

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ({ getAttendanceExportRows } = await import("@/lib/attendance-analytics-db"));

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-attn-export-${suffix}`, name: "TEST Attendance Export Restaurant", timezone: TZ })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-attn-export-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

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
      .values({ fullName: "TEST Export Alice", phone: `9771${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userAId = userA.id;

    const [userB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Export Bob", phone: `9772${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userBId = userB.id;

    await db.insert(schema.userRoles).values([
      { userId: userAId, restaurantId, branchId: branchAId, role: "waiter", isActive: true },
      { userId: userBId, restaurantId, branchId: branchBId, role: "waiter", isActive: true },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.holidays).where(eq(schema.holidays.restaurantId, restaurantId));
    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.restaurantId, restaurantId));
    await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.restaurantId, restaurantId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userAId));
    await db.delete(schema.users).where(eq(schema.users.id, userBId));
  });

  it("returns no rows for a day with no signal at all", async () => {
    const rows = await getAttendanceExportRows(restaurantId, "2026-02-01", "2026-02-28", TZ, null);
    expect(rows).toEqual([]);
  });

  it("classifies a plain clock-in/out with no schedule as 'present'", async () => {
    await db.insert(schema.attendanceRecords).values({
      restaurantId,
      userId: userAId,
      clockInAt: new Date("2026-03-05T09:00:00Z"),
      clockOutAt: new Date("2026-03-05T17:00:00Z"),
      status: "verified",
    });

    const rows = await getAttendanceExportRows(restaurantId, "2026-03-01", "2026-03-31", TZ, null);
    const row = rows.find((r) => r.userId === userAId && r.date === "2026-03-05");
    expect(row?.status).toBe("present");
    expect(row?.clockInAt?.toISOString()).toBe("2026-03-05T09:00:00.000Z");

    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
  });

  it("classifies a late-but-completed matched shift as 'late', and an unmatched no-show as 'no_show'", async () => {
    // Both dated safely in the past relative to the real clock, same
    // reasoning as attendance-analytics-db.test.ts's own no-show case.
    await db.insert(schema.scheduledShifts).values([
      {
        restaurantId,
        userId: userAId,
        shiftDate: "2026-01-02",
        plannedStartAt: new Date("2026-01-02T09:00:00Z"),
        plannedEndAt: new Date("2026-01-02T17:00:00Z"),
      },
      {
        restaurantId,
        userId: userAId,
        shiftDate: "2026-01-03",
        plannedStartAt: new Date("2026-01-03T09:00:00Z"),
        plannedEndAt: new Date("2026-01-03T17:00:00Z"),
      },
    ]);
    await db.insert(schema.attendanceRecords).values({
      restaurantId,
      userId: userAId,
      clockInAt: new Date("2026-01-02T09:20:00Z"), // 20 min late - 5 min grace = 15
      clockOutAt: new Date("2026-01-02T17:00:00Z"),
      status: "verified",
    });

    const rows = await getAttendanceExportRows(restaurantId, "2026-01-01", "2026-01-31", TZ, null);
    const lateRow = rows.find((r) => r.userId === userAId && r.date === "2026-01-02");
    expect(lateRow?.status).toBe("late");
    expect(lateRow?.lateMinutes).toBe(15);

    const noShowRow = rows.find((r) => r.userId === userAId && r.date === "2026-01-03");
    expect(noShowRow?.status).toBe("no_show");
    expect(noShowRow?.clockInAt).toBeNull();

    await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.userId, userAId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
  });

  it("classifies an approved paid leave day (with no clock-in) as 'on_leave'", async () => {
    await db.insert(schema.leaveRequests).values({
      restaurantId,
      userId: userAId,
      leaveType: "sick",
      status: "approved",
      startDate: "2026-04-10",
      endDate: "2026-04-11",
    });

    const rows = await getAttendanceExportRows(restaurantId, "2026-04-01", "2026-04-30", TZ, null);
    const day1 = rows.find((r) => r.userId === userAId && r.date === "2026-04-10");
    const day2 = rows.find((r) => r.userId === userAId && r.date === "2026-04-11");
    expect(day1?.status).toBe("on_leave");
    expect(day2?.status).toBe("on_leave");

    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userAId));
  });

  it("classifies a restaurant-wide holiday (no clock-in) as 'holiday'", async () => {
    await db.insert(schema.holidays).values({ restaurantId, date: "2026-05-01", name: "TEST Holiday" });

    const rows = await getAttendanceExportRows(restaurantId, "2026-05-01", "2026-05-01", TZ, null);
    // Every active staff member gets a holiday row, not just one.
    expect(rows.filter((r) => r.date === "2026-05-01" && r.status === "holiday").map((r) => r.userId).sort()).toEqual(
      [userAId, userBId].sort(),
    );

    await db.delete(schema.holidays).where(eq(schema.holidays.restaurantId, restaurantId));
  });

  it("an actual clock-in wins over a same-day leave/holiday signal", async () => {
    await db.insert(schema.leaveRequests).values({
      restaurantId,
      userId: userAId,
      leaveType: "sick",
      status: "approved",
      startDate: "2026-06-15",
      endDate: "2026-06-15",
    });
    await db.insert(schema.attendanceRecords).values({
      restaurantId,
      userId: userAId,
      clockInAt: new Date("2026-06-15T09:00:00Z"),
      clockOutAt: new Date("2026-06-15T17:00:00Z"),
      status: "verified",
    });

    const rows = await getAttendanceExportRows(restaurantId, "2026-06-01", "2026-06-30", TZ, null);
    const row = rows.find((r) => r.userId === userAId && r.date === "2026-06-15");
    expect(row?.status).toBe("present");

    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userAId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
  });

  it("wrong-restaurant isolation: never returns another restaurant's attendance", async () => {
    await db.insert(schema.attendanceRecords).values({
      restaurantId: otherRestaurantId,
      userId: userAId,
      clockInAt: new Date("2026-07-01T09:00:00Z"),
      clockOutAt: new Date("2026-07-01T17:00:00Z"),
      status: "verified",
    });

    const rows = await getAttendanceExportRows(restaurantId, "2026-07-01", "2026-07-31", TZ, null);
    expect(rows.some((r) => r.date === "2026-07-01")).toBe(false);

    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, otherRestaurantId));
  });

  it("branch scoping: a specific branchId returns only that branch's staff", async () => {
    await db.insert(schema.attendanceRecords).values([
      {
        restaurantId,
        userId: userAId,
        clockInAt: new Date("2026-08-01T09:00:00Z"),
        clockOutAt: new Date("2026-08-01T17:00:00Z"),
        status: "verified",
      },
      {
        restaurantId,
        userId: userBId,
        clockInAt: new Date("2026-08-01T09:00:00Z"),
        clockOutAt: new Date("2026-08-01T17:00:00Z"),
        status: "verified",
      },
    ]);

    const branchAOnly = await getAttendanceExportRows(restaurantId, "2026-08-01", "2026-08-31", TZ, branchAId);
    expect(branchAOnly.map((r) => r.userId)).toEqual([userAId]);

    const branchBOnly = await getAttendanceExportRows(restaurantId, "2026-08-01", "2026-08-31", TZ, branchBId);
    expect(branchBOnly.map((r) => r.userId)).toEqual([userBId]);

    const unscoped = await getAttendanceExportRows(restaurantId, "2026-08-01", "2026-08-31", TZ, null);
    expect(unscoped.map((r) => r.userId).sort()).toEqual([userAId, userBId].sort());

    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
  });
});
