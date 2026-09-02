import "server-only";
import { and, eq, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords, holidays, leaveRequests, scheduledShifts, userRoles, users } from "@/db/schema";
import {
  classifyAttendanceDay,
  computeStaffAttendanceAnalytics,
  isDateHoliday,
  isDateWithinLeaveRanges,
  type AttendanceDayStatus,
  type StaffAttendanceAnalytics,
} from "@/lib/attendance-analytics";
import { leaveDaysWithinPeriod } from "@/lib/leave";
import { matchScheduleWithAttendance, type MatchedShift } from "@/lib/scheduling-db";
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
 *
 * Correctness fix (attendance-overhaul gap audit, P1): a scheduled shift
 * that falls on a day the staff member had APPROVED leave covering, or a
 * day the branch/restaurant declared a HOLIDAY, must never be tallied as a
 * no-show or late arrival — the staff member had no obligation to clock in
 * that day. Before this fix, computeStaffAttendanceAnalytics's matchedShifts
 * carried no such signal, so an approved-leave or holiday day with no
 * clock-in silently fell through to ScheduleStatus "no_show" from
 * scheduling.ts's computeScheduleVariance (which only ever compares planned
 * times against attendance — it has no leave/holiday awareness of its own,
 * by design) and got counted twice: once correctly as paid leave, and once
 * incorrectly as a no-show. Fixed here — not in payroll.ts, which already
 * only reasons about worked minutes and leaveDaysWithinPeriod and was never
 * exposed to this bug — by resolving each matched shift's `excusedReason`
 * (via isDateWithinLeaveRanges/isDateHoliday) before handing it to the pure
 * aggregator, which now excludes an excused shift from noShowCount/
 * lateCount and tallies it into excusedLeaveCount/excusedHolidayCount
 * instead.
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
      branchId: scheduledShifts.branchId,
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

  // Correctness fix (P1 gap-audit finding) — approved leave excuses a
  // no-show/late tally regardless of leave TYPE, unlike paidLeaveDaysByUserId
  // above: an approved unpaid-leave day still means the staff member had
  // permission not to be there, so it must exclude a no-show just as much
  // as a paid leave day does. This is deliberately a separate query/map
  // from leaveRows (not a relaxed reuse of it) since the two answer
  // different questions — "how many paid leave days" vs. "was this staff
  // member excused from being at work at all" — and conflating them would
  // either under-count paid leave or under-excuse unpaid leave.
  const allApprovedLeaveRows = await db
    .select({ userId: leaveRequests.userId, startDate: leaveRequests.startDate, endDate: leaveRequests.endDate })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.restaurantId, restaurantId),
        inArray(leaveRequests.userId, userIds),
        eq(leaveRequests.status, "approved"),
        lte(leaveRequests.startDate, periodEnd),
        gte(leaveRequests.endDate, periodStart),
      ),
    );
  const leaveRangesByUserId = new Map<string, Array<{ startDate: string; endDate: string }>>();
  for (const r of allApprovedLeaveRows) {
    const list = leaveRangesByUserId.get(r.userId);
    const range = { startDate: r.startDate, endDate: r.endDate };
    if (list) list.push(range);
    else leaveRangesByUserId.set(r.userId, [range]);
  }

  // Declared holidays overlapping the period — branchId null means
  // restaurant-wide (see the holidays table's own schema comment), set
  // means that one branch's own closure. Not filtered by `branchId` (the
  // function's own branch-scoping parameter): a branch-scoped caller has
  // already narrowed `userIds` to that branch's roster, but an individual
  // SHIFT's own branchId (below) is what determines which holidays excuse
  // it, same as it determines who's on the roster in the first place.
  const holidayRows = await db
    .select({ date: holidays.date, branchId: holidays.branchId })
    .from(holidays)
    .where(
      and(eq(holidays.restaurantId, restaurantId), gte(holidays.date, periodStart), lte(holidays.date, periodEnd)),
    );
  const restaurantWideHolidayDates = new Set<string>();
  const branchHolidayDatesByBranch = new Map<string, Set<string>>();
  for (const h of holidayRows) {
    if (h.branchId === null) {
      restaurantWideHolidayDates.add(h.date);
    } else {
      const set = branchHolidayDatesByBranch.get(h.branchId);
      if (set) set.add(h.date);
      else branchHolidayDatesByBranch.set(h.branchId, new Set([h.date]));
    }
  }

  /** "leave" wins over "holiday" when a day happens to be both — either way it's excused, but leave is the more specific, person-level reason to surface to a manager. */
  function resolveExcusedReason(userId: string, shiftDate: string, shiftBranchId: string | null): "leave" | "holiday" | undefined {
    if (isDateWithinLeaveRanges(shiftDate, leaveRangesByUserId.get(userId) ?? [])) return "leave";
    if (isDateHoliday(shiftDate, shiftBranchId, restaurantWideHolidayDates, branchHolidayDatesByBranch)) return "holiday";
    return undefined;
  }

  // Matching uses EVERY attendance record regardless of review status — a
  // late/no-show call is about clock TIMES, not about whether a manager
  // has since verified the shift's photo, so it's a deliberately separate
  // concern from the rejected-exclusion applied below for the worked-time
  // figures.
  const matched = matchScheduleWithAttendance(shiftRows, attendanceRows, timezone);
  const matchedByUserId = new Map<string, Array<{ variance: (typeof matched)[number]["variance"]; excusedReason?: "leave" | "holiday" }>>();
  for (const m of matched) {
    const entry = {
      variance: m.variance,
      excusedReason: resolveExcusedReason(m.shift.userId, m.shift.shiftDate, m.shift.branchId),
    };
    const list = matchedByUserId.get(m.shift.userId);
    if (list) list.push(entry);
    else matchedByUserId.set(m.shift.userId, [entry]);
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

export type AttendanceExportRow = {
  userId: string;
  fullName: string;
  date: string;
  status: AttendanceDayStatus;
  clockInAt: Date | null;
  clockOutAt: Date | null;
  lateMinutes: number;
};

/** Every "YYYY-MM-DD" from `start` to `end`, inclusive — plain calendar-date
 * enumeration (no timezone conversion, same date-string arithmetic as
 * leave.ts's leaveDayCount), used only to expand an approved leave range
 * into individual day rows for the export below. */
function enumerateDates(start: string, end: string): string[] {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  const dates: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    const d = new Date(ms);
    dates.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return dates;
}

/**
 * Commercial completion pass — Data Export gap (attendance). Per-staff,
 * per-day rows for the /attendance/export route — same roster/branch-
 * scoping and same three data sources (attendanceRecords, scheduledShifts,
 * leaveRequests) as getAttendanceAnalytics above, plus restaurant holidays,
 * reduced through classifyAttendanceDay (attendance-analytics.ts) instead
 * of computeStaffAttendanceAnalytics — one row per (staff, calendar day)
 * that has at least one signal, rather than one row per staff for the
 * whole period. Never invents a row for an ordinary day off (no shift, no
 * attendance, not on leave, not a holiday) — see classifyAttendanceDay's
 * own comment on why that returns null rather than some "off" status.
 */
export async function getAttendanceExportRows(
  restaurantId: string,
  periodStart: string,
  periodEnd: string,
  timezone: string,
  branchId: string | null,
): Promise<AttendanceExportRow[]> {
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
  // Same rejected-shift exclusion as computeStaffAttendanceAnalytics — a
  // rejected selfie means the shift's evidence didn't hold up, so it
  // shouldn't read as "present" on the export either.
  const countedAttendance = attendanceRows.filter((r) => r.status !== "rejected");

  // Aggregate to one (earliest clock-in, latest clock-out) per (user, local
  // day) — an export row is per DAY, not per individual clock event.
  const attendanceByUserDay = new Map<string, { clockInAt: Date; clockOutAt: Date | null }>();
  for (const r of countedAttendance) {
    const day = restaurantDate(timezone, r.clockInAt);
    const key = `${r.userId}:${day}`;
    const existing = attendanceByUserDay.get(key);
    if (!existing) {
      attendanceByUserDay.set(key, { clockInAt: r.clockInAt, clockOutAt: r.clockOutAt });
    } else {
      attendanceByUserDay.set(key, {
        clockInAt: r.clockInAt < existing.clockInAt ? r.clockInAt : existing.clockInAt,
        clockOutAt:
          r.clockOutAt && (!existing.clockOutAt || r.clockOutAt > existing.clockOutAt)
            ? r.clockOutAt
            : existing.clockOutAt,
      });
    }
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
  const matched: MatchedShift<(typeof shiftRows)[number]>[] = matchScheduleWithAttendance(
    shiftRows,
    attendanceRows,
    timezone,
  );
  const matchedByUserDay = new Map<string, MatchedShift<(typeof shiftRows)[number]>>();
  for (const m of matched) {
    matchedByUserDay.set(`${m.shift.userId}:${m.shift.shiftDate}`, m);
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
  const leaveDatesByUserId = new Map<string, Set<string>>();
  for (const r of leaveRows) {
    const clippedStart = r.startDate > periodStart ? r.startDate : periodStart;
    const clippedEnd = r.endDate < periodEnd ? r.endDate : periodEnd;
    if (clippedStart > clippedEnd) continue;
    const set = leaveDatesByUserId.get(r.userId) ?? new Set<string>();
    for (const date of enumerateDates(clippedStart, clippedEnd)) set.add(date);
    leaveDatesByUserId.set(r.userId, set);
  }

  // Restaurant-wide holidays (branchId null) apply to every staff member;
  // a branch-specific one only applies when this export is itself scoped
  // to that same branch — same single-branchId scoping the rest of this
  // function (and getAttendanceAnalytics above) already applies, rather
  // than resolving each staff member's own branch individually.
  const holidayRows = await db
    .select({ date: holidays.date, branchId: holidays.branchId })
    .from(holidays)
    .where(
      and(
        eq(holidays.restaurantId, restaurantId),
        gte(holidays.date, periodStart),
        lte(holidays.date, periodEnd),
        branchId === null ? undefined : or(isNull(holidays.branchId), eq(holidays.branchId, branchId)),
      ),
    );
  const holidayDates = new Set(holidayRows.map((h) => h.date));

  const rows: AttendanceExportRow[] = [];
  for (const userId of userIds) {
    const fullName = staffByUserId.get(userId)!.fullName;
    const leaveDates = leaveDatesByUserId.get(userId) ?? new Set<string>();

    const days = new Set<string>();
    for (const key of attendanceByUserDay.keys()) {
      if (key.startsWith(`${userId}:`)) days.add(key.slice(userId.length + 1));
    }
    for (const key of matchedByUserDay.keys()) {
      if (key.startsWith(`${userId}:`)) days.add(key.slice(userId.length + 1));
    }
    for (const date of leaveDates) days.add(date);
    for (const date of holidayDates) days.add(date);

    for (const date of days) {
      const attendance = attendanceByUserDay.get(`${userId}:${date}`);
      const matchedShift = matchedByUserDay.get(`${userId}:${date}`);
      const status = classifyAttendanceDay(
        attendance,
        matchedShift?.variance,
        leaveDates.has(date),
        holidayDates.has(date),
      );
      if (!status) continue;
      rows.push({
        userId,
        fullName,
        date,
        status,
        clockInAt: attendance?.clockInAt ?? null,
        clockOutAt: attendance?.clockOutAt ?? null,
        lateMinutes: matchedShift?.variance.lateMinutes ?? 0,
      });
    }
  }

  return rows.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.date.localeCompare(b.date));
}
