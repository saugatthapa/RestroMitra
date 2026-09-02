import "server-only";
import { and, eq, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { db } from "@/db";
import {
  attendanceDayStatuses,
  attendanceRecords,
  holidays,
  leaveRequests,
  scheduledShifts,
  userRoles,
  users,
} from "@/db/schema";
import {
  classifyAttendanceDay,
  computeStaffAttendanceAnalytics,
  isDateHoliday,
  isDateWithinLeaveRanges,
  type AttendanceDayStatus,
  type StaffAttendanceAnalytics,
} from "@/lib/attendance-analytics";
import { leaveDaysWithinPeriod } from "@/lib/leave";
import { generateDateRange } from "@/lib/reports-helpers";
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

export interface AttendanceDayStatusRow {
  userId: string;
  /** See attendance_day_statuses' own schema comment: derived from whichever attendance/shift record the day was classified from, or null when the day has neither (a pure leave/holiday day). */
  branchId: string | null;
  /** Restaurant-local "YYYY-MM-DD". */
  date: string;
  status: AttendanceDayStatus;
}

/**
 * Phase 18 (Attendance overhaul, Track B — Daily status persistence) — the
 * DB-backed half of classifyAttendanceDay: for every active staff member
 * in scope (same roster query/branch-scoping rule as getAttendanceAnalytics
 * above), classifies EVERY restaurant-local calendar day in
 * [periodStart, periodEnd] that has at least one signal worth classifying
 * — a clock-in, a scheduled shift, an approved leave request, or a
 * declared holiday — reusing classifyAttendanceDay as the one place that
 * priority-ordering decision is made. Days with no signal at all for a
 * given user are simply never produced (there is nothing to classify —
 * see classifyAttendanceDay's own null case), not a wasted computation.
 *
 * A day with more than one shift/attendance record (see scheduling.ts's
 * own disclosed split-shift limitation) picks the EARLIEST attendance
 * record and the EARLIEST-starting matched shift for that day as the
 * representative pair fed into classifyAttendanceDay — the same "correct
 * for the overwhelmingly common single-shift-per-day case, a known,
 * disclosed limitation for genuine split shifts" stance scheduling.ts
 * already takes, not a new limitation invented here.
 *
 * Unlike paidLeaveDaysByUserId above (which deliberately excludes unpaid
 * leave — a payroll-scoped question), leave here is NOT filtered by
 * leaveType: an approved unpaid leave day is still a day the person was
 * legitimately away, which is what "on_leave" attendance status means.
 * Whether that absence was PAID is a separate, payroll-scoped question
 * this column doesn't answer.
 *
 * A holiday applies to a given user when it's restaurant-wide
 * (holidays.branchId is null) or matches that user's own branch grant
 * (userRoles.branchId) — deliberately the person's HOME branch, not
 * whatever branch their attendance/shift happened to be stamped with that
 * day, so a pure holiday-only day (no attendance, no shift at all) can
 * still resolve correctly for a branch-scoped staff member.
 */
/**
 * The same active-staff-roster resolution getAttendanceAnalytics/
 * computeAttendanceDayStatusRows both need — factored out so
 * computeAndPersistAttendanceDayStatuses can independently learn WHICH
 * users are in scope for the stale-row cleanup below even on a run whose
 * fresh computation produces zero rows (every prior signal for this
 * roster disappeared at once) — see that function's own doc comment.
 */
async function resolveActiveStaffRoster(restaurantId: string, branchId: string | null) {
  return db
    .select({ userId: users.id, homeBranchId: userRoles.branchId })
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
}

export async function computeAttendanceDayStatusRows(
  restaurantId: string,
  periodStart: string,
  periodEnd: string,
  timezone: string,
  branchId: string | null,
): Promise<AttendanceDayStatusRow[]> {
  const staffRows = await resolveActiveStaffRoster(restaurantId, branchId);
  if (staffRows.length === 0) return [];

  const staffByUserId = new Map(staffRows.map((s) => [s.userId, s]));
  const userIds = [...staffByUserId.keys()];

  const dayStart = restaurantStartOfDay(timezone, periodStart);
  const dayAfterEnd = new Date(restaurantStartOfDay(timezone, periodEnd).getTime() + 24 * 60 * 60 * 1000);

  const attendanceRows = await db
    .select({
      userId: attendanceRecords.userId,
      branchId: attendanceRecords.branchId,
      clockInAt: attendanceRecords.clockInAt,
      clockOutAt: attendanceRecords.clockOutAt,
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

  const localDate = (d: Date) => restaurantDate(timezone, d);

  // Per (user, day): the EARLIEST attendance record — see this function's
  // own doc comment on the split-shift representative-pair choice.
  const attendanceByUserDay = new Map<
    string,
    Map<string, { clockInAt: Date; clockOutAt: Date | null; branchId: string | null }>
  >();
  for (const r of attendanceRows) {
    const day = localDate(r.clockInAt);
    const byDay = attendanceByUserDay.get(r.userId) ?? new Map();
    const existing = byDay.get(day);
    if (!existing || r.clockInAt.getTime() < existing.clockInAt.getTime()) {
      byDay.set(day, { clockInAt: r.clockInAt, clockOutAt: r.clockOutAt, branchId: r.branchId });
    }
    attendanceByUserDay.set(r.userId, byDay);
  }

  const shiftRows = await db
    .select({
      userId: scheduledShifts.userId,
      branchId: scheduledShifts.branchId,
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
  // Same "every attendance record regardless of review status" reasoning
  // as getAttendanceAnalytics above — a late/no-show call is about clock
  // TIMES, independent of whether a manager has since verified the photo.
  const matched = matchScheduleWithAttendance(shiftRows, attendanceRows, timezone);

  // Per (user, day): the matched shift with the EARLIEST plannedStartAt.
  const matchedByUserDay = new Map<
    string,
    Map<string, { variance: (typeof matched)[number]["variance"]; branchId: string | null; plannedStartAt: Date }>
  >();
  for (const m of matched) {
    const day = m.shift.shiftDate;
    const byDay = matchedByUserDay.get(m.shift.userId) ?? new Map();
    const existing = byDay.get(day);
    if (!existing || m.shift.plannedStartAt.getTime() < existing.plannedStartAt.getTime()) {
      byDay.set(day, { variance: m.variance, branchId: m.shift.branchId, plannedStartAt: m.shift.plannedStartAt });
    }
    matchedByUserDay.set(m.shift.userId, byDay);
  }

  // ALL approved leave (every leaveType, including unpaid) — see this
  // function's own doc comment on why this deliberately differs from
  // paidLeaveDaysByUserId above.
  const leaveRows = await db
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
  const leaveRangesByUserId = new Map<string, typeof leaveRows>();
  for (const r of leaveRows) {
    const list = leaveRangesByUserId.get(r.userId);
    if (list) list.push(r);
    else leaveRangesByUserId.set(r.userId, [r]);
  }

  const holidayRows = await db
    .select({ branchId: holidays.branchId, date: holidays.date })
    .from(holidays)
    .where(and(eq(holidays.restaurantId, restaurantId), gte(holidays.date, periodStart), lte(holidays.date, periodEnd)));

  const results: AttendanceDayStatusRow[] = [];
  for (const userId of userIds) {
    const homeBranchId = staffByUserId.get(userId)!.homeBranchId;
    const attendanceDays = attendanceByUserDay.get(userId) ?? new Map();
    const matchedDays = matchedByUserDay.get(userId) ?? new Map();
    const userLeaveRanges = leaveRangesByUserId.get(userId) ?? [];
    const applicableHolidays = holidayRows.filter((h) => h.branchId === null || h.branchId === homeBranchId);

    // Union of every day with at least one signal for this user — see
    // this function's own doc comment on why a day with none is never
    // produced at all.
    const daySet = new Set<string>([...attendanceDays.keys(), ...matchedDays.keys()]);
    for (const range of userLeaveRanges) {
      const clippedStart = range.startDate > periodStart ? range.startDate : periodStart;
      const clippedEnd = range.endDate < periodEnd ? range.endDate : periodEnd;
      for (const day of generateDateRange(clippedStart, clippedEnd)) daySet.add(day);
    }
    for (const h of applicableHolidays) daySet.add(h.date);

    for (const day of daySet) {
      const attendanceForDay = attendanceDays.get(day);
      const matchedForDay = matchedDays.get(day);
      const isOnLeave = userLeaveRanges.some((r) => r.startDate <= day && day <= r.endDate);
      const isHoliday = applicableHolidays.some((h) => h.date === day);

      const status = classifyAttendanceDay(
        attendanceForDay ? { clockInAt: attendanceForDay.clockInAt, clockOutAt: attendanceForDay.clockOutAt } : undefined,
        matchedForDay ? { status: matchedForDay.variance.status, lateMinutes: matchedForDay.variance.lateMinutes } : undefined,
        isOnLeave,
        isHoliday,
      );
      if (status === null) continue; // nothing to persist — see attendance_day_statuses' own schema comment

      results.push({
        userId,
        date: day,
        status,
        branchId: matchedForDay?.branchId ?? attendanceForDay?.branchId ?? null,
      });
    }
  }
  return results;
}

/**
 * Freezes computeAttendanceDayStatusRows' output into attendance_day_
 * statuses — "recompute and overwrite," same upsert-on-recompute pattern as
 * entitlements-db.ts's setEntitlementOverride, via the (restaurantId,
 * userId, date) unique index. Runs inside one transaction so a concurrent
 * reader of the table never observes a half-written period: either it sees
 * the previous computation in full, or this one in full, never a mix.
 *
 * Also deletes any PREVIOUSLY persisted row, for one of this call's own
 * users within [periodStart, periodEnd], that the fresh computation did
 * NOT reproduce — the "stale row" case attendance_day_statuses' own schema
 * comment calls out (e.g. a leave request cancelled after being persisted
 * as on_leave, with nothing else that day to reclassify it to). Scoped to
 * exactly the userIds this call's roster covers, so it never touches a
 * different branch-scoped call's rows for the same restaurant/period.
 *
 * Called from the attendance analytics route (see its own doc comment) —
 * the on-demand path that already exists for viewing a period's attendance
 * figures is this feature's natural "finalize now" moment, the same way
 * this codebase's other on-demand, no-cron-infrastructure computations
 * (Daily Closing's preview/close, payroll's computation batch) are
 * triggered by a person opening the relevant screen rather than by a
 * background job this project doesn't otherwise run.
 *
 * Deliberately resolves the staff roster itself (via
 * resolveActiveStaffRoster), rather than deriving "which users are in
 * scope" purely from computeAttendanceDayStatusRows' own output — a run
 * whose FRESH computation produces zero rows (every prior signal for this
 * whole roster disappeared at once — e.g. every leave request for the
 * period got cancelled) must still reconcile away whatever stale rows
 * that roster had persisted from an earlier run; deriving scope only from
 * a possibly-empty `rows` array would silently skip that cleanup.
 */
export async function computeAndPersistAttendanceDayStatuses(
  restaurantId: string,
  periodStart: string,
  periodEnd: string,
  timezone: string,
  branchId: string | null,
): Promise<AttendanceDayStatusRow[]> {
  const staffRows = await resolveActiveStaffRoster(restaurantId, branchId);
  if (staffRows.length === 0) return [];
  const userIds = staffRows.map((s) => s.userId);

  const rows = await computeAttendanceDayStatusRows(restaurantId, periodStart, periodEnd, timezone, branchId);
  const freshKeys = new Set(rows.map((r) => `${r.userId}:${r.date}`));

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ userId: attendanceDayStatuses.userId, date: attendanceDayStatuses.date })
      .from(attendanceDayStatuses)
      .where(
        and(
          eq(attendanceDayStatuses.restaurantId, restaurantId),
          inArray(attendanceDayStatuses.userId, userIds),
          gte(attendanceDayStatuses.date, periodStart),
          lte(attendanceDayStatuses.date, periodEnd),
        ),
      );
    const staleUserIds: string[] = [];
    const staleDates: string[] = [];
    for (const row of existing) {
      if (!freshKeys.has(`${row.userId}:${row.date}`)) {
        staleUserIds.push(row.userId);
        staleDates.push(row.date);
      }
    }
    if (staleUserIds.length > 0) {
      // No composite-tuple delete helper in this codebase's drizzle usage
      // elsewhere — same one-row-at-a-time deletion this stale-row case
      // is expected to be rare/small (a leave cancellation, a corrected
      // attendance record removed entirely), not a hot path worth a
      // fancier batched form.
      for (let i = 0; i < staleUserIds.length; i++) {
        await tx
          .delete(attendanceDayStatuses)
          .where(
            and(
              eq(attendanceDayStatuses.restaurantId, restaurantId),
              eq(attendanceDayStatuses.userId, staleUserIds[i]),
              eq(attendanceDayStatuses.date, staleDates[i]),
            ),
          );
      }
    }

    for (const row of rows) {
      await tx
        .insert(attendanceDayStatuses)
        .values({
          restaurantId,
          userId: row.userId,
          branchId: row.branchId,
          date: row.date,
          status: row.status,
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [attendanceDayStatuses.restaurantId, attendanceDayStatuses.userId, attendanceDayStatuses.date],
          set: { branchId: row.branchId, status: row.status, computedAt: new Date() },
        });
    }
  });

  return rows;
}

/**
 * Cheap, computation-free read of already-persisted attendance_day_
 * statuses rows for a period — the "repeated report reads become cheap
 * lookups instead of repeated computation" half of this feature. Does NOT
 * fall back to computing anything live; a caller that also needs the
 * table kept fresh should call computeAndPersistAttendanceDayStatuses
 * first (as the analytics route does), same "write path and read path are
 * separate, composable calls" shape as the rest of this module.
 */
export async function getAttendanceDayStatuses(
  restaurantId: string,
  periodStart: string,
  periodEnd: string,
  branchId: string | null,
): Promise<AttendanceDayStatusRow[]> {
  const conditions = [
    eq(attendanceDayStatuses.restaurantId, restaurantId),
    gte(attendanceDayStatuses.date, periodStart),
    lte(attendanceDayStatuses.date, periodEnd),
  ];
  // Same "null branchId row is restaurant-wide/unscoped, visible from any
  // branch filter" convention as holidays/getAttendanceAnalytics — a
  // ?branchId= filter narrows to that branch's OWN rows plus every
  // unscoped one, it never hides unscoped rows entirely.
  if (branchId !== null) {
    conditions.push(or(isNull(attendanceDayStatuses.branchId), eq(attendanceDayStatuses.branchId, branchId))!);
  }

  const rows = await db
    .select({
      userId: attendanceDayStatuses.userId,
      branchId: attendanceDayStatuses.branchId,
      date: attendanceDayStatuses.date,
      status: attendanceDayStatuses.status,
    })
    .from(attendanceDayStatuses)
    .where(and(...conditions));
  return rows;
}
