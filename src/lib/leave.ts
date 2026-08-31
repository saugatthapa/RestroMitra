/**
 * Phase 14 (Attendance overhaul, Track B) — pure, dependency-free leave-
 * request logic, paired with leave-requests-db.ts for the DB-backed half
 * (same "pure module + *-db.ts counterpart" split as attendance.ts /
 * attendance-photos-db.ts). Nothing here touches the database or "now" —
 * every function is a plain, independently-testable transform over the
 * values a route handler already has in hand.
 */

export type LeaveType = "sick" | "casual" | "unpaid" | "other";

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  sick: "Sick leave",
  casual: "Casual leave",
  unpaid: "Unpaid leave",
  other: "Other",
};

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

/**
 * startDate/endDate are plain "YYYY-MM-DD" strings (see leaveRequests'
 * schema comment) — lexicographic string comparison is equivalent to
 * chronological comparison for that fixed-width format, so no Date
 * parsing is needed here.
 */
export function isValidLeaveRange(startDate: string, endDate: string): boolean {
  return endDate >= startDate;
}

/** Inclusive day count between two "YYYY-MM-DD" dates, e.g. Mon..Mon = 1. */
export function leaveDayCount(startDate: string, endDate: string): number {
  const start = Date.UTC(...parseDateOnly(startDate));
  const end = Date.UTC(...parseDateOnly(endDate));
  return Math.round((end - start) / 86_400_000) + 1;
}

function parseDateOnly(value: string): [number, number, number] {
  const [year, month, day] = value.split("-").map(Number);
  return [year, month - 1, day];
}

/** Only a still-PENDING request can be cancelled (by its own requester) or reviewed (by a manager) — once decided, it's a closed record, same "no reopening" restraint as attendance corrections. */
export function canCancelLeaveRequest(status: LeaveStatus): boolean {
  return status === "pending";
}

export function canReviewLeaveRequest(status: LeaveStatus): boolean {
  return status === "pending";
}

/** Whether two inclusive "YYYY-MM-DD" date ranges share at least one day. */
export function leaveRangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Phase 16 (Attendance overhaul, Track B — Analytics & payroll integration)
 * — how many days of a [leaveStart, leaveEnd] request fall inside
 * [periodStart, periodEnd] (all inclusive "YYYY-MM-DD"). Used both by
 * payroll.ts (a daily-rate staff member's approved paid leave days still
 * count toward that period's pay) and attendance-analytics-db.ts (a leave
 * breakdown scoped to the reporting period) — a leave request spanning
 * three months shouldn't have all its days attributed to just the one
 * period a manager happens to be looking at. Returns 0 when the ranges
 * don't overlap at all (mirrors leaveRangesOverlap's boundary logic,
 * clipped rather than boolean).
 */
export function leaveDaysWithinPeriod(
  leaveStart: string,
  leaveEnd: string,
  periodStart: string,
  periodEnd: string,
): number {
  const clippedStart = leaveStart > periodStart ? leaveStart : periodStart;
  const clippedEnd = leaveEnd < periodEnd ? leaveEnd : periodEnd;
  if (clippedStart > clippedEnd) return 0;
  return leaveDayCount(clippedStart, clippedEnd);
}
