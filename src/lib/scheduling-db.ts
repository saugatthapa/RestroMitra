import "server-only";
import { restaurantDate } from "./restaurant-date";
import { pairShiftsWithAttendance, computeScheduleVariance, type ScheduleVariance } from "./scheduling";

export interface MatchedShift<S> {
  shift: S;
  attendance: { clockInAt: Date; clockOutAt: Date | null } | null;
  variance: ScheduleVariance;
}

/**
 * Groups `shifts` and `attendanceRecords` into (userId, restaurant-local
 * day) buckets — timezone-aware, hence living here rather than in
 * scheduling.ts (restaurantDate() is "server-only") — then pairs each
 * bucket via pairShiftsWithAttendance and computes each shift's variance.
 * `now` is threaded through purely so callers/tests can pin "the current
 * instant" rather than this depending on the real clock.
 */
export function matchScheduleWithAttendance<
  S extends { userId: string; shiftDate: string; plannedStartAt: Date; plannedEndAt: Date },
  A extends { userId: string; clockInAt: Date; clockOutAt: Date | null },
>(
  shifts: S[],
  attendanceRecords: A[],
  timezone: string | null | undefined,
  now: Date = new Date(),
): MatchedShift<S>[] {
  const attendanceByKey = new Map<string, A[]>();
  for (const record of attendanceRecords) {
    const key = `${record.userId}:${restaurantDate(timezone, record.clockInAt)}`;
    const bucket = attendanceByKey.get(key);
    if (bucket) bucket.push(record);
    else attendanceByKey.set(key, [record]);
  }

  const shiftsByKey = new Map<string, S[]>();
  for (const shift of shifts) {
    const key = `${shift.userId}:${shift.shiftDate}`;
    const bucket = shiftsByKey.get(key);
    if (bucket) bucket.push(shift);
    else shiftsByKey.set(key, [shift]);
  }

  const results: MatchedShift<S>[] = [];
  for (const [key, keyShifts] of shiftsByKey) {
    const keyAttendance = attendanceByKey.get(key) ?? [];
    for (const { shift, attendance } of pairShiftsWithAttendance(keyShifts, keyAttendance)) {
      results.push({
        shift,
        attendance,
        variance: computeScheduleVariance(shift.plannedStartAt, shift.plannedEndAt, attendance, now),
      });
    }
  }
  return results;
}
