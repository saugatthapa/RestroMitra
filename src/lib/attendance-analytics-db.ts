import "server-only";
import { and, eq, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords, leaveRequests, scheduledShifts, userRoles, users } from "@/db/schema";
import {
  computeStaffAttendanceAnalytics,
  type StaffAttendanceAnalytics,
} from "@/lib/attendance-analytics";
import { leaveDaysWithinPeriod } from "@/lib/leave";
import { matchScheduleWithAttendance } from "@/lib/scheduling-db";
import { restaurantDate, restaurantStartOfDay } from "@/lib/restaurant-date";

export type StaffAttendanceAnalyticsRow = StaffAttendanceAnalytics & { fullName: string };

/**
 * Phase 16 (Attendance overhaul, Track B — Analytics & payroll integration)
 * — the DB-backed half of attendance-analytics.ts: resolves the active
 * staff roster (same branch-scoping rule as payroll/staff route.ts —
 * `branchId === null` sees everyone, otherwise a branch plus every
 * restaurant-wide/unscoped staff member) and, for each of them, gathers
 * the same three data sources payroll.ts and the schedule route already
 * each query separately — attendanceRecords, scheduledShifts, and
 * leaveRequests — in exactly one query per source for the whole roster
 * (same "1 query, not N" shape as getPayrollComputationsBatch), then
 * reduces each into a StaffAttendanceAnalyticsRow via the pure aggregator.
 *
 * Never omits a staff member: every active roster row gets a result, even
 * one with zero activity in the period (matching
 * getPayrollComputationsBatch's own "never omits one" convention).
 */
export async function getAttendanceAnalytics(
  restaurantId: string,
  periodStart: string,
  periodEnd: string,
  timezone: string,
  branchId: string | null,
): Promise<StaffAttendanceAnalyticsRow[]> {
  const staffRows = await db
    .select({ userId: users.id, fullName: users.fullName })
    .from(userRoles)
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(
      branchId === null
        ? and(eq(userRoles.restaurantId, restaurantId), eq(userRoles.isActive, true))
        : and(
            eq(userRoles.restaurantId, restaurantId),
            eq(userRoles.isActive, true),
            or(isNull(userRoles.branchId), eq(userRoles.branchId, branchId)),
          ),
    );
  if (staffRows.length === 0) return [];

  // A single physical user can hold more than one userRoles row at this
  // restaurant only in edge cases this project doesn't otherwise dedupe
  // against elsewhere either; de-duplicating here keeps this function's
  // own output free of a repeated row for the same person regardless.
  const staffByUserId = new Map(staffRows.map((s) => [s.userId, s]));
  const userIds = [...staffByUserId.keys()];

  const dayStart = restaurantStartOfDay(timezone, periodStart);
  const dayAfterEnd = new Date(restaurantStartOfDay(timezone, periodEnd).getTime() + 24 * 60 * 60 * 1000);

  const attendanceRows = await db
    .select({
      userId: attendanceRecords.userId,
      clockInAt: attendanceRecords.clockInAt,
      clockOutAt: attendanceRecords.clockOutAt,
      status: attendanceRecords.status,
    })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.restaurantId, restaurantId),
        inArray(attendanceRecords.userId, userIds),
        gte(attendanceRecords.clockInAt, dayStart),
        lt(attendanceRecords.clockInAt, dayAfterEnd),
      ),
    );
  const attendanceByUserId = new Map<string, typeof attendanceRows>();
  for (const r of attendanceRows) {
    const list = attendanceByUserId.get(r.userId);
    if (list) list.push(r);
    else attendanceByUserId.set(r.userId, [r]);
  }

  const shiftRows = await db
    .select({
      userId: scheduledShifts.userId,
      shiftDate: scheduledShifts.shiftDate,
      plannedStartAt: scheduledShifts.plannedStartAt,
      plannedEndAt: scheduledShifts.plannedEndAt,
    })
    .from(scheduledShifts)
    .where(
      and(
        eq(scheduledShifts.restaurantId, restaurantId),
        inArray(scheduledShifts.userId, userIds),
        gte(scheduledShifts.shiftDate, periodStart),
        lte(scheduledShifts.shiftDate, periodEnd),
      ),
    );
  // Matching uses EVERY attendance record regardless of review status — a
  // late/no-show call is about clock TIMES, not about whether a manager
  // has since verified the shift's photo, so it's a deliberately separate
  // concern from the rejected-exclusion applied below for the worked-time
  // figures.
  const matched = matchScheduleWithAttendance(shiftRows, attendanceRows, timezone);
  const matchedByUserId = new Map<string, typeof matched>();
  for (const m of matched) {
    const list = matchedByUserId.get(m.shift.userId);
    if (list) list.push(m);
    else matchedByUserId.set(m.shift.userId, [m]);
  }

  const leaveRows = await db
    .select({ userId: leaveRequests.userId, startDate: leaveRequests.startDate, endDate: leaveRequests.endDate })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.restaurantId, restaurantId),
        inArray(leaveRequests.userId, userIds),
        eq(leaveRequests.status, "approved"),
        ne(leaveRequests.leaveType, "unpaid"),
        lte(leaveRequests.startDate, periodEnd),
        gte(leaveRequests.endDate, periodStart),
      ),
    );
  const paidLeaveDaysByUserId = new Map<string, number>();
  for (const r of leaveRows) {
    const days = leaveDaysWithinPeriod(r.startDate, r.endDate, periodStart, periodEnd);
    paidLeaveDaysByUserId.set(r.userId, (paidLeaveDaysByUserId.get(r.userId) ?? 0) + days);
  }

  const localDate = (d: Date) => restaurantDate(timezone, d);

  return userIds
    .map((userId) => {
      const analytics = computeStaffAttendanceAnalytics(
        userId,
        attendanceByUserId.get(userId) ?? [],
        matchedByUserId.get(userId) ?? [],
        paidLeaveDaysByUserId.get(userId) ?? 0,
        localDate,
      );
      return { ...analytics, fullName: staffByUserId.get(userId)!.fullName };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
