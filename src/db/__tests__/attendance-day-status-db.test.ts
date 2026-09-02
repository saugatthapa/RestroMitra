/**
 * Phase 18 (Attendance overhaul, Track B — Daily status persistence) —
 * integration tests for attendance-analytics-db.ts's
 * computeAttendanceDayStatusRows / computeAndPersistAttendanceDayStatuses /
 * getAttendanceDayStatuses, end to end against real Postgres. Same
 * "call the *-db.ts functions directly, not just prove query shapes"
 * approach as attendance-analytics-db.test.ts.
 *
 * These tests do NOT re-litigate classifyAttendanceDay's own priority
 * ordering — attendance-analytics.test.ts already covers that in full.
 * What's proven here is the wiring: that the persisted row for a given
 * (user, day) matches what classifyAttendanceDay would compute live for
 * the same inputs, that a repeat computation upserts (overwrites) rather
 * than duplicating, that a day whose signal disappears gets its stale row
 * deleted rather than left behind, and that getAttendanceDayStatuses is a
 * genuine read of the persisted table — not a silent no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);
const TZ = "UTC";

describe.skipIf(!hasDb)("attendance day status persistence (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let computeAttendanceDayStatusRows: typeof import("@/lib/attendance-analytics-db").computeAttendanceDayStatusRows;
  let computeAndPersistAttendanceDayStatuses: typeof import("@/lib/attendance-analytics-db").computeAndPersistAttendanceDayStatuses;
  let getAttendanceDayStatuses: typeof import("@/lib/attendance-analytics-db").getAttendanceDayStatuses;

  let restaurantId: string;
  let branchAId: string;
  let userAId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ({ computeAttendanceDayStatusRows, computeAndPersistAttendanceDayStatuses, getAttendanceDayStatuses } =
      await import("@/lib/attendance-analytics-db"));

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-attn-daystatus-${suffix}`, name: "TEST Attendance Day Status Restaurant", timezone: TZ })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Day Status Branch A" })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [userA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Day Status Alice", phone: `9764${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userAId = userA.id;

    await db.insert(schema.userRoles).values([
      { userId: userAId, restaurantId, branchId: branchAId, role: "waiter", isActive: true },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.attendanceDayStatuses).where(eq(schema.attendanceDayStatuses.restaurantId, restaurantId));
    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.restaurantId, restaurantId));
    await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.restaurantId, restaurantId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
    await db.delete(schema.holidays).where(eq(schema.holidays.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userAId));
  });

  it("computes no rows for a period with no signal at all", async () => {
    const rows = await computeAttendanceDayStatusRows(restaurantId, "2026-08-01", "2026-08-31", TZ, null);
    expect(rows).toEqual([]);
  });

  it("classifies a plain clock-in with no matched schedule as 'present', matching classifyAttendanceDay for the same inputs", async () => {
    const { classifyAttendanceDay } = await import("@/lib/attendance-analytics");
    await db.insert(schema.attendanceRecords).values({
      restaurantId,
      userId: userAId,
      branchId: branchAId,
      clockInAt: new Date("2026-09-01T09:00:00Z"),
      clockOutAt: new Date("2026-09-01T17:00:00Z"),
      status: "verified",
    });

    const rows = await computeAttendanceDayStatusRows(restaurantId, "2026-09-01", "2026-09-30", TZ, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: userAId, date: "2026-09-01", branchId: branchAId });
    // The persisted classification must be EXACTLY what the pure function
    // computes for the equivalent inputs — no reimplemented logic here.
    expect(rows[0].status).toBe(
      classifyAttendanceDay(
        { clockInAt: new Date("2026-09-01T09:00:00Z"), clockOutAt: null },
        undefined,
        false,
        false,
      ),
    );

    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
  });

  it("classifies a late clock-in (matched to a scheduled shift) as 'late'", async () => {
    await db.insert(schema.scheduledShifts).values({
      restaurantId,
      userId: userAId,
      branchId: branchAId,
      shiftDate: "2026-01-02",
      plannedStartAt: new Date("2026-01-02T09:00:00Z"),
      plannedEndAt: new Date("2026-01-02T17:00:00Z"),
    });
    await db.insert(schema.attendanceRecords).values({
      restaurantId,
      userId: userAId,
      branchId: branchAId,
      clockInAt: new Date("2026-01-02T09:20:00Z"), // 20 min late - 5 min grace = 15
      clockOutAt: new Date("2026-01-02T17:00:00Z"),
      status: "verified",
    });

    const rows = await computeAttendanceDayStatusRows(restaurantId, "2026-01-01", "2026-01-31", TZ, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: userAId, date: "2026-01-02", status: "late" });

    await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.userId, userAId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
  });

  it("classifies an unmatched scheduled shift with nothing clocked in as 'no_show' once the shift has ended", async () => {
    await db.insert(schema.scheduledShifts).values({
      restaurantId,
      userId: userAId,
      branchId: branchAId,
      shiftDate: "2026-01-03",
      plannedStartAt: new Date("2026-01-03T09:00:00Z"),
      plannedEndAt: new Date("2026-01-03T17:00:00Z"),
    });

    const rows = await computeAttendanceDayStatusRows(restaurantId, "2026-01-01", "2026-01-31", TZ, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: userAId, date: "2026-01-03", status: "no_show", branchId: branchAId });

    await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.userId, userAId));
  });

  it("classifies an approved leave day (no schedule, no clock-in) as 'on_leave', clipped to the requested period", async () => {
    await db.insert(schema.leaveRequests).values({
      restaurantId,
      userId: userAId,
      leaveType: "sick",
      status: "approved",
      startDate: "2026-10-05",
      endDate: "2026-10-06",
    });

    const rows = await computeAttendanceDayStatusRows(restaurantId, "2026-10-01", "2026-10-31", TZ, null);
    expect(rows.map((r) => r.date).sort()).toEqual(["2026-10-05", "2026-10-06"]);
    expect(rows.every((r) => r.status === "on_leave")).toBe(true);

    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userAId));
  });

  it("persists computed rows into attendance_day_statuses and getAttendanceDayStatuses reads them back without recomputing", async () => {
    await db.insert(schema.attendanceRecords).values({
      restaurantId,
      userId: userAId,
      branchId: branchAId,
      clockInAt: new Date("2026-11-01T09:00:00Z"),
      clockOutAt: new Date("2026-11-01T17:00:00Z"),
      status: "verified",
    });

    const written = await computeAndPersistAttendanceDayStatuses(restaurantId, "2026-11-01", "2026-11-30", TZ, null);
    expect(written).toHaveLength(1);

    const persisted = await db
      .select()
      .from(schema.attendanceDayStatuses)
      .where(eq(schema.attendanceDayStatuses.userId, userAId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ restaurantId, userId: userAId, date: "2026-11-01", status: "present" });

    // getAttendanceDayStatuses is a plain read — deleting the underlying
    // attendance record must NOT change what it returns until the next
    // compute-and-persist call, proving it doesn't silently recompute.
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
    const readBack = await getAttendanceDayStatuses(restaurantId, "2026-11-01", "2026-11-30", null);
    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toMatchObject({ userId: userAId, date: "2026-11-01", status: "present" });

    await db.delete(schema.attendanceDayStatuses).where(eq(schema.attendanceDayStatuses.userId, userAId));
  });

  it("a repeat compute-and-persist call upserts (overwrites) rather than duplicating the row", async () => {
    await db.insert(schema.scheduledShifts).values({
      restaurantId,
      userId: userAId,
      branchId: branchAId,
      shiftDate: "2026-06-15",
      plannedStartAt: new Date("2026-06-15T09:00:00Z"),
      plannedEndAt: new Date("2026-06-15T17:00:00Z"),
    });
    // First compute: nothing clocked in yet on a shift dated in the past —
    // resolves to no_show.
    const first = await computeAndPersistAttendanceDayStatuses(restaurantId, "2026-06-15", "2026-06-15", TZ, null);
    expect(first[0].status).toBe("no_show");

    // A late clock-in now lands on the same shift — reclassifies to "late".
    await db.insert(schema.attendanceRecords).values({
      restaurantId,
      userId: userAId,
      branchId: branchAId,
      clockInAt: new Date("2026-06-15T09:20:00Z"),
      clockOutAt: new Date("2026-06-15T17:00:00Z"),
      status: "verified",
    });
    const second = await computeAndPersistAttendanceDayStatuses(restaurantId, "2026-06-15", "2026-06-15", TZ, null);
    expect(second[0].status).toBe("late");

    const rows = await db
      .select()
      .from(schema.attendanceDayStatuses)
      .where(eq(schema.attendanceDayStatuses.userId, userAId));
    // Exactly one row — overwritten, not duplicated.
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("late");

    await db.delete(schema.attendanceDayStatuses).where(eq(schema.attendanceDayStatuses.userId, userAId));
    await db.delete(schema.scheduledShifts).where(eq(schema.scheduledShifts.userId, userAId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
  });

  it("deletes a previously persisted row when its signal disappears and the day reclassifies to null", async () => {
    await db.insert(schema.leaveRequests).values({
      restaurantId,
      userId: userAId,
      leaveType: "casual",
      status: "approved",
      startDate: "2027-02-10",
      endDate: "2027-02-10",
    });
    const first = await computeAndPersistAttendanceDayStatuses(restaurantId, "2027-02-01", "2027-02-28", TZ, null);
    expect(first).toHaveLength(1);
    let rows = await db
      .select()
      .from(schema.attendanceDayStatuses)
      .where(eq(schema.attendanceDayStatuses.userId, userAId));
    expect(rows).toHaveLength(1);

    // The leave request is deleted outright (e.g. cancelled) — nothing
    // else exists on that day, so the fresh computation produces zero
    // rows for the period; the stale persisted row must be cleaned up.
    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userAId));
    const second = await computeAndPersistAttendanceDayStatuses(restaurantId, "2027-02-01", "2027-02-28", TZ, null);
    expect(second).toEqual([]);

    rows = await db.select().from(schema.attendanceDayStatuses).where(eq(schema.attendanceDayStatuses.userId, userAId));
    expect(rows).toHaveLength(0);
  });

  it("branch scoping: getAttendanceDayStatuses narrows to one branch's rows plus unscoped ones, same convention as getAttendanceAnalytics", async () => {
    await db.insert(schema.attendanceRecords).values({
      restaurantId,
      userId: userAId,
      branchId: branchAId,
      clockInAt: new Date("2026-11-05T09:00:00Z"),
      clockOutAt: new Date("2026-11-05T17:00:00Z"),
      status: "verified",
    });
    await computeAndPersistAttendanceDayStatuses(restaurantId, "2026-11-05", "2026-11-05", TZ, null);

    const scoped = await getAttendanceDayStatuses(restaurantId, "2026-11-05", "2026-11-05", branchAId);
    expect(scoped).toHaveLength(1);

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Day Status Branch Other" })
      .returning({ id: schema.branches.id });
    const otherBranchScoped = await getAttendanceDayStatuses(restaurantId, "2026-11-05", "2026-11-05", otherBranch.id);
    expect(otherBranchScoped).toHaveLength(0);

    await db.delete(schema.branches).where(eq(schema.branches.id, otherBranch.id));
    await db.delete(schema.attendanceDayStatuses).where(eq(schema.attendanceDayStatuses.userId, userAId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userAId));
  });
});
