/**
 * Attendance math — Phase 8. Deliberately a plain, dependency-free module
 * (no "server-only", no DB import), same pattern as order-status.ts,
 * payments.ts, and kds.ts, so it's shared unmodified between the
 * clock-in/out API routes and the dashboard attendance view.
 */

export type AttendanceRecord = {
  clockInAt: string | Date;
  clockOutAt: string | Date | null;
};

/** True when a record represents a shift that hasn't been clocked out of yet. */
export function isOpenShift(record: AttendanceRecord): boolean {
  return record.clockOutAt === null;
}

/**
 * Minutes worked so far on a shift — from clockInAt to clockOutAt, or to
 * `now` for a still-open shift (so a live "X minutes and counting" display
 * doesn't need its own separate calculation).
 */
export function computeDurationMinutes(record: AttendanceRecord, now: Date = new Date()): number {
  const start = new Date(record.clockInAt).getTime();
  const end = record.clockOutAt ? new Date(record.clockOutAt).getTime() : now.getTime();
  return Math.max(0, Math.round((end - start) / 60_000));
}

/** Formats a minute count as "Xh Ym" (or just "Ym" under an hour). */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** Sums completed-shift minutes across a set of records for a simple "hours this period" total. Open shifts count up to `now`. */
export function totalMinutes(records: AttendanceRecord[], now: Date = new Date()): number {
  return records.reduce((sum, r) => sum + computeDurationMinutes(r, now), 0);
}

/**
 * Phase 13 (Attendance overhaul, Track B) — the review status a shift
 * carries. A selfie-verified restaurant's whole point is that a human
 * eventually LOOKS at the captured photo(s) — matching a client-supplied
 * key to a real object in storage (Phase 12) only proves that account
 * uploaded some photo, never that the photo genuinely shows that person.
 * "verified"/"rejected" is that human judgment call; "needs_review" is the
 * default whenever there's a photo nobody has looked at yet.
 */
export type AttendanceStatus = "needs_review" | "verified" | "rejected";

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  needs_review: "Needs review",
  verified: "Verified",
  rejected: "Rejected",
};

/**
 * The status a brand-new record starts at, right after clock-in. Nothing
 * to review (no photo — either the restaurant doesn't require one, or this
 * one clock-in was submitted without one) auto-"verified", the same
 * implicit trust every pre-Phase-12 clock-in already had. A photo present
 * means there's now something a human needs to actually look at.
 */
export function initialAttendanceStatus(hasClockInPhoto: boolean): AttendanceStatus {
  return hasClockInPhoto ? "needs_review" : "verified";
}

/**
 * The status a record transitions to at clock-out. A clock-out photo is a
 * SECOND, separate thing to look at — even a record an owner already
 * marked "verified" from its clock-in photo goes back to "needs_review"
 * once a new, not-yet-looked-at clock-out photo lands on it. No clock-out
 * photo at all leaves whatever status clock-in already produced untouched
 * (an owner's earlier verified/rejected call about the clock-in photo
 * still stands — clocking out with no photo doesn't erase it).
 */
export function attendanceStatusAfterClockOut(
  currentStatus: AttendanceStatus,
  hasClockOutPhoto: boolean,
): AttendanceStatus {
  return hasClockOutPhoto ? "needs_review" : currentStatus;
}

/**
 * Commercial Launch Phase B.2 (Payroll Upgrades) — the attendance-side
 * inputs a payroll computation needs: total minutes worked (for hourly
 * pay) and distinct CALENDAR days with at least one shift (for daily pay).
 * `localDate` buckets each record's clockInAt into a day — pass a
 * restaurant-timezone-aware bucketer (e.g. `(d) => restaurantDate(tz, d)`
 * from restaurant-date.ts) so "days present" matches the restaurant's own
 * wall-clock day, same convention reports.ts uses throughout. Kept here
 * (not in payroll.ts) since it's purely attendance-shape math with no DB
 * dependency, same as totalMinutes above — payroll.ts calls this, not the
 * other way around.
 */
export function summarizeAttendance(
  records: AttendanceRecord[],
  localDate: (d: Date) => string,
  now: Date = new Date(),
): { totalMinutes: number; daysPresent: number } {
  const days = new Set(records.map((r) => localDate(new Date(r.clockInAt))));
  return { totalMinutes: totalMinutes(records, now), daysPresent: days.size };
}
