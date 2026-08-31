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
  };
}

/**
 * `records` are every attendance record (any status) this staff member
 * clocked in the period — the "rejected" ones are filtered out here (and
 * counted separately), the caller doesn't need to pre-filter.
 * `matchedShifts` are the scheduling-db.ts matchScheduleWithAttendance
 * results already scoped to this one user (variance only — the shift/
 * attendance objects themselves aren't needed for the aggregate figures).
 * `paidLeaveDays` is a precomputed input (see this module's own top
 * comment on why) rather than something computed in here.
 */
export function computeStaffAttendanceAnalytics(
  userId: string,
  records: (AttendanceRecord & { status: AttendanceStatus })[],
  matchedShifts: Array<{ variance: { status: ScheduleStatus; lateMinutes: number; earlyDepartureMinutes: number } }>,
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
  for (const { variance } of matchedShifts) {
    if (variance.status === "completed") completedShiftsCount++;
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
  };
}
