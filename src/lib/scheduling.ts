/**
 * Phase 15 (Attendance overhaul, Track B — Scheduling) — pure, dependency-
 * free logic for comparing a planned shift against actual attendance. Paired
 * with scheduling-db.ts for the timezone-aware grouping/matching half (same
 * "pure module + *-db.ts counterpart" split as attendance.ts /
 * attendance-photos-db.ts, leave.ts / the leave-requests routes).
 */

export type ScheduleStatus = "upcoming" | "in_progress" | "completed" | "no_show";

export const SCHEDULE_STATUS_LABELS: Record<ScheduleStatus, string> = {
  upcoming: "Upcoming",
  in_progress: "In progress",
  completed: "Completed",
  no_show: "No-show",
};

/**
 * Minutes of slack before a late clock-in / early clock-out actually counts
 * as a variance worth surfacing — avoids flagging ordinary minute-level
 * clock skew (a phone clock a couple minutes off, walking from the door to
 * the till) as "late."
 */
export const SCHEDULE_GRACE_MINUTES = 5;

export interface ScheduleVariance {
  status: ScheduleStatus;
  /** Minutes late clocking in, past the grace period. 0 if on time or early. */
  lateMinutes: number;
  /** Minutes short of the planned end at clock-out, past the grace period. 0 if not clocked out, or on/after time. */
  earlyDepartureMinutes: number;
}

/**
 * Compares one planned shift to (at most) one matching attendance record.
 * `attendance` is null when nothing has been matched to this shift yet —
 * see scheduling-db.ts's matchScheduleWithAttendance for how that matching
 * happens.
 */
export function computeScheduleVariance(
  plannedStartAt: Date,
  plannedEndAt: Date,
  attendance: { clockInAt: Date; clockOutAt: Date | null } | null,
  now: Date = new Date(),
): ScheduleVariance {
  if (!attendance) {
    if (now.getTime() >= plannedEndAt.getTime()) {
      return { status: "no_show", lateMinutes: 0, earlyDepartureMinutes: 0 };
    }
    return {
      status: now.getTime() < plannedStartAt.getTime() ? "upcoming" : "in_progress",
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
    };
  }

  const lateMinutes = Math.max(
    0,
    Math.round((attendance.clockInAt.getTime() - plannedStartAt.getTime()) / 60_000) - SCHEDULE_GRACE_MINUTES,
  );

  if (!attendance.clockOutAt) {
    return { status: "in_progress", lateMinutes, earlyDepartureMinutes: 0 };
  }

  const earlyDepartureMinutes = Math.max(
    0,
    Math.round((plannedEndAt.getTime() - attendance.clockOutAt.getTime()) / 60_000) - SCHEDULE_GRACE_MINUTES,
  );

  return { status: "completed", lateMinutes, earlyDepartureMinutes };
}

/**
 * Best-effort pairing of one user's scheduled shifts with their attendance
 * records on the same restaurant-local day — both lists are expected to
 * already be filtered to one (user, day) by the caller (see
 * scheduling-db.ts). Sorts each list chronologically and zips them
 * positionally: correct for the overwhelmingly common single-shift-per-day
 * case; for a genuine split-shift day this can mispair (e.g. an early
 * no-show paired with a later, unrelated clock-in). That's a known,
 * disclosed limitation — solving it properly needs either an explicit
 * shift-to-record link a person confirms, or a fussier nearest-neighbor
 * matcher, and isn't worth the complexity until split shifts are common
 * enough to be a real product ask.
 */
export function pairShiftsWithAttendance<S extends { plannedStartAt: Date }, A extends { clockInAt: Date }>(
  shifts: S[],
  attendance: A[],
): Array<{ shift: S; attendance: A | null }> {
  const sortedShifts = [...shifts].sort((a, b) => a.plannedStartAt.getTime() - b.plannedStartAt.getTime());
  const sortedAttendance = [...attendance].sort((a, b) => a.clockInAt.getTime() - b.clockInAt.getTime());
  return sortedShifts.map((shift, i) => ({ shift, attendance: sortedAttendance[i] ?? null }));
}

/**
 * The Monday..Sunday "YYYY-MM-DD" pair for the week containing `dateStr` —
 * the schedule GET route's default window when no ?from=&to= is given.
 * Plain date-string arithmetic (Date.UTC on the parsed Y/M/D, never the
 * system/local timezone), same "no timezone conversion needed for a
 * calendar-date-only computation" reasoning as leaveDayCount above.
 */
export function weekRangeContaining(dateStr: string): [string, string] {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isoDayOfWeek = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6 (JS's getUTCDay is Sun=0)
  const monday = new Date(date.getTime() - isoDayOfWeek * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return [toDateOnly(monday), toDateOnly(sunday)];
}

function toDateOnly(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
