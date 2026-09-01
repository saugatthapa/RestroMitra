/**
 * Phase 16 (Attendance overhaul, Track B — Analytics & payroll integration)
 * — pure, dependency-free aggregation of one staff member's attendance
 * figures over a reporting period, for the Attendance tab's analytics
 * panel. Paired with attendance-analytics-db.ts for the DB-backed half
 * (same "pure module + *-db.ts counterpart" split as attendance.ts /
 * attendance-photos-db.ts, leave.ts / the leave-requests routes,
 * scheduling.ts / scheduling-db.ts — this module is the natural
 * confluence of all three: it reuses attendance.ts's summarizeAttendance
 * for the raw worked-time figures and scheduling.ts's ScheduleVariance
 * shape for lateness/no-show counts, and takes paidLeaveDays as an input
 * rather than recomputing it — attendance-analytics-db.ts and payroll.ts
 * both derive it the same way, via leave.ts's leaveDaysWithinPeriod, so
 * the arithmetic lives in exactly one place).
 */

import { summarizeAttendance, type AttendanceRecord, type AttendanceStatus } from "./attendance";
import type { ScheduleStatus } from "./scheduling";

export interface StaffAttendanceAnalytics {
  userId: string;
  /** Minutes worked across all NON-rejected attendance records in the period (see attendance.ts's totalMinutes). */
  totalMinutes: number;
  /** Distinct restaurant-local calendar days with at least one non-rejected shift. */
  daysPresent: number;
  /**
   * Attendance records a manager reviewed and rejected — excluded from
   * totalMinutes/daysPresent above (their photo evidence didn't hold up,
   * same trust boundary payroll.ts now applies), but still worth surfacing
   * as its own count: a staff member with a lot of rejected shifts is a
   * signal worth a manager's attention on its own, separate from pay.
   */
  rejectedShiftsCount: number;
  /** Approved, non-unpaid leave days within the period (see leave.ts's leaveDaysWithinPeriod). */
  paidLeaveDays: number;
  /** How many scheduled shifts this staff member had in the period, regardless of outcome. */
  scheduledShiftsCount: number;
  /** Scheduled shifts that ended in ScheduleStatus "completed" (clocked in AND out, matched to the shift). */
  completedShiftsCount: number;
  /** Scheduled shifts with ScheduleStatus "no_show" — never clocked in by the time the shift ended. */
  noShowCount: number;
  /** Scheduled shifts clocked in later than SCHEDULE_GRACE_MINUTES past the planned start. */
  lateCount: number;
  /** Sum of every matched shift's lateMinutes (0 for on-time/early ones). */
  totalLateMinutes: number;
  /** Sum of every matched shift's earlyDepartureMinutes. */
  totalEarlyDepartureMinutes: number;
  /**
   * Matched shifts that would otherwise have tallied as a no-show or a
   * late arrival, but fell on a day the staff member had approved leave
   * covering — excluded from noShowCount/lateCount/totalLateMinutes/
   * totalEarlyDepartureMinutes above (see computeStaffAttendanceAnalytics'
   * `excusedReason` handling) and counted here instead, so a manager sees
   * WHY the figure is lower rather than the day just silently vanishing.
   */
  excusedLeaveCount: number;
  /** Same exclusion as excusedLeaveCount, but for a branch/restaurant-wide declared holiday instead of personal leave. */
  excusedHolidayCount: number;
}

/** The all-zeros shape for a staff member with no activity at all in the period — never omit a row, same convention as payroll.ts's getPayrollComputationsBatch. */
export function emptyStaffAttendanceAnalytics(userId: string): StaffAttendanceAnalytics {
  return {
    userId,
    totalMinutes: 0,
    daysPresent: 0,
    rejectedShiftsCount: 0,
    paidLeaveDays: 0,
    scheduledShiftsCount: 0,
    completedShiftsCount: 0,
    noShowCount: 0,
    lateCount: 0,
    totalLateMinutes: 0,
    totalEarlyDepartureMinutes: 0,
    excusedLeaveCount: 0,
    excusedHolidayCount: 0,
  };
}

/**
 * Whether restaurant-local calendar day `dateStr` falls within at least one
 * of the given approved leave ranges for the same staff member. Deliberately
 * ANY leave type (paid or unpaid) counts here, unlike paidLeaveDays above —
 * this isn't about pay, it's about whether the staff member had permission
 * to be absent that day, so an approved unpaid-leave day must excuse a
 * no-show just as much as a paid one does.
 */
export function isDateWithinLeaveRanges(
  dateStr: string,
  leaveRanges: Array<{ startDate: string; endDate: string }>,
): boolean {
  return leaveRanges.some((r) => r.startDate <= dateStr && dateStr <= r.endDate);
}

/**
 * Whether `dateStr` is a declared holiday applicable to a shift scheduled
 * at `shiftBranchId` (null for a restaurant-wide/unscoped shift). A
 * restaurant-wide holiday (declared with branchId null) always applies; a
 * branch-specific holiday applies only to a shift AT that same branch — an
 * unscoped shift only ever matches a restaurant-wide holiday, same
 * "unscoped sees only unscoped" caution used for staff-roster branch
 * scoping in this module's *-db.ts counterpart.
 */
export function isDateHoliday(
  dateStr: string,
  shiftBranchId: string | null,
  restaurantWideHolidayDates: ReadonlySet<string>,
  branchHolidayDatesByBranch: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (restaurantWideHolidayDates.has(dateStr)) return true;
  if (shiftBranchId) {
    return branchHolidayDatesByBranch.get(shiftBranchId)?.has(dateStr) ?? false;
  }
  return false;
}

/**
 * `records` are every attendance record (any status) this staff member
 * clocked in the period — the "rejected" ones are filtered out here (and
 * counted separately), the caller doesn't need to pre-filter.
 * `matchedShifts` are the scheduling-db.ts matchScheduleWithAttendance
 * results already scoped to this one user (variance plus an optional
 * `excusedReason` — the shift/attendance objects themselves aren't needed
 * for the aggregate figures). `excusedReason` is precomputed by the caller
 * (attendance-analytics-db.ts, via isDateWithinLeaveRanges/isDateHoliday
 * above) since determining it needs the staff member's leave ranges and the
 * restaurant/branch's declared holidays — DB-shaped inputs this pure
 * function deliberately doesn't touch. When set, that shift is EXCLUDED
 * from noShowCount/lateCount/totalLateMinutes/totalEarlyDepartureMinutes
 * and tallied into excusedLeaveCount/excusedHolidayCount instead — a staff
 * member who didn't clock in because they were on approved leave, or
 * because the branch was closed for a declared holiday, was never
 * obligated to show up that day, so counting it against them corrupts the
 * report exactly the way payroll.ts already avoids for actual pay (see
 * this module's own leaveDaysWithinPeriod-derived paidLeaveDays input —
 * this is the same correctness guarantee, just applied to the no-show/late
 * tallies payroll never touches).
 * `paidLeaveDays` is a precomputed input (see this module's own top
 * comment on why) rather than something computed in here.
 */
export function computeStaffAttendanceAnalytics(
  userId: string,
  records: (AttendanceRecord & { status: AttendanceStatus })[],
  matchedShifts: Array<{
    variance: { status: ScheduleStatus; lateMinutes: number; earlyDepartureMinutes: number };
    excusedReason?: "leave" | "holiday";
  }>,
  paidLeaveDays: number,
  localDate: (d: Date) => string,
  now: Date = new Date(),
): StaffAttendanceAnalytics {
  const countedRecords = records.filter((r) => r.status !== "rejected");
  const rejectedShiftsCount = records.length - countedRecords.length;
  const summary = summarizeAttendance(countedRecords, localDate, now);

  let completedShiftsCount = 0;
  let noShowCount = 0;
  let lateCount = 0;
  let totalLateMinutes = 0;
  let totalEarlyDepartureMinutes = 0;
  let excusedLeaveCount = 0;
  let excusedHolidayCount = 0;
  for (const { variance, excusedReason } of matchedShifts) {
    if (variance.status === "completed") completedShiftsCount++;

    if (excusedReason === "leave") {
      excusedLeaveCount++;
      continue;
    }
    if (excusedReason === "holiday") {
      excusedHolidayCount++;
      continue;
    }

    if (variance.status === "no_show") noShowCount++;
    if (variance.lateMinutes > 0) {
      lateCount++;
      totalLateMinutes += variance.lateMinutes;
    }
    totalEarlyDepartureMinutes += variance.earlyDepartureMinutes;
  }

  return {
    userId,
    totalMinutes: summary.totalMinutes,
    daysPresent: summary.daysPresent,
    rejectedShiftsCount,
    paidLeaveDays,
    scheduledShiftsCount: matchedShifts.length,
    completedShiftsCount,
    noShowCount,
    lateCount,
    totalLateMinutes,
    totalEarlyDepartureMinutes,
    excusedLeaveCount,
    excusedHolidayCount,
  };
}
