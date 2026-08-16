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
