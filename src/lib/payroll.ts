import "server-only";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords, staffSalaryConfigs, userRoles } from "@/db/schema";
import { summarizeAttendance } from "@/lib/attendance";
import { restaurantDate, restaurantStartOfDay } from "@/lib/restaurant-date";
import type { SalaryType } from "@/lib/finance/salary-type";

/**
 * Commercial Launch Phase B.2 — Payroll Upgrades. Wires attendance data
 * into payroll for the first time (previously staffSalaryConfigs.salaryType
 * could be "hourly"/"daily" but nothing ever computed an actual amount from
 * hours/days worked — the Pay form just defaulted to the raw standing
 * figure regardless of type). This module is the computation; the payroll
 * routes/UI decide when to call it and how much of the result to trust
 * blindly vs. let a human override.
 *
 * The amount OWED for a staff member's salaryType/standing rate over a
 * period, given how much they worked. Deliberately simple, no invented
 * policy this project was never asked for:
 *  - monthly: the full standing amount, UNPRORATED by attendance — most
 *    small restaurants don't dock a fixed monthly salary day-by-day, and
 *    inventing a proration rule (which days count, how a partial month at
 *    hire/termination is handled) is a policy decision with no spec here.
 *    getPayrollComputation still returns the attendance figures alongside
 *    it so a manager can SEE the days/hours worked and decide for
 *    themselves whether an adjustment is warranted — the system just
 *    doesn't auto-deduct for them.
 *  - daily: amountInPaisa (the daily rate) × distinct calendar days present.
 *  - hourly: amountInPaisa (the hourly rate) × hours worked, rounded to
 *    the nearest paisa (not the nearest hour).
 */
export function computeOwedAmountInPaisa(
  salaryType: SalaryType,
  amountInPaisa: number,
  attendance: { totalMinutes: number; daysPresent: number },
): number {
  switch (salaryType) {
    case "monthly":
      return amountInPaisa;
    case "daily":
      return amountInPaisa * attendance.daysPresent;
    case "hourly":
      return Math.round((amountInPaisa * attendance.totalMinutes) / 60);
    default:
      return amountInPaisa;
  }
}

export type PayrollComputation = {
  salaryType: SalaryType;
  standingAmountInPaisa: number;
  attendanceMinutes: number;
  attendanceDays: number;
  owedAmountInPaisa: number;
};

/**
 * Resolves one staff member's owed amount for [periodStart, periodEnd]
 * (inclusive, YYYY-MM-DD — same convention as reports.ts's ReportDateRange)
 * from their standing staffSalaryConfigs + attendanceRecords in that
 * window. A shift is attributed to the period it CLOCKED IN during, in
 * full, even if the clock-out spills slightly past the boundary — same
 * "attribute the whole event to when it started" simplification reports.ts
 * already uses for orders (see that module's dayBounds comment); an
 * attendance record's clockOutAt is never used to decide inclusion, only
 * clockInAt.
 *
 * Returns null when no salary config is set — there's nothing to compute
 * against (matches the existing "Not set" UI state on the Payroll tab).
 */
export async function getPayrollComputation(
  restaurantId: string,
  userRoleId: string,
  periodStart: string,
  periodEnd: string,
  timezone: string,
): Promise<PayrollComputation | null> {
  const [roleRow] = await db
    .select({
      userId: userRoles.userId,
      salaryType: staffSalaryConfigs.salaryType,
      amountInPaisa: staffSalaryConfigs.amountInPaisa,
    })
    .from(userRoles)
    .innerJoin(staffSalaryConfigs, eq(staffSalaryConfigs.userRoleId, userRoles.id))
    .where(and(eq(userRoles.id, userRoleId), eq(userRoles.restaurantId, restaurantId)))
    .limit(1);
  if (!roleRow) return null;

  const dayStart = restaurantStartOfDay(timezone, periodStart);
  const dayAfterEnd = new Date(restaurantStartOfDay(timezone, periodEnd).getTime() + 24 * 60 * 60 * 1000);

  const records = await db
    .select({ clockInAt: attendanceRecords.clockInAt, clockOutAt: attendanceRecords.clockOutAt })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.restaurantId, restaurantId),
        eq(attendanceRecords.userId, roleRow.userId),
        gte(attendanceRecords.clockInAt, dayStart),
        lt(attendanceRecords.clockInAt, dayAfterEnd),
      ),
    );

  const summary = summarizeAttendance(records, (d) => restaurantDate(timezone, d));
  const owedAmountInPaisa = computeOwedAmountInPaisa(roleRow.salaryType, roleRow.amountInPaisa, summary);

  return {
    salaryType: roleRow.salaryType,
    standingAmountInPaisa: roleRow.amountInPaisa,
    attendanceMinutes: summary.totalMinutes,
    attendanceDays: summary.daysPresent,
    owedAmountInPaisa,
  };
}

export type StaffSalaryInput = {
  userRoleId: string;
  userId: string;
  salaryType: SalaryType;
  amountInPaisa: number;
};

/**
 * Batched sibling of getPayrollComputation() — computes owed amounts for
 * MULTIPLE staff members over the same [periodStart, periodEnd] window in
 * exactly ONE attendanceRecords query, instead of one query per staff
 * member.
 *
 * QA hardening pass (Phase 27 / performance audit) — the payroll roster
 * route (payroll/staff/route.ts) used to call getPayrollComputation() once
 * per salaried staff member via Promise.all. Each call re-ran the
 * userRoles/staffSalaryConfigs join (redundant — the roster route had
 * ALREADY joined and fetched that same salary config for its own listing)
 * and its own separate attendanceRecords query. Parallelizing with
 * Promise.all hides the added LATENCY somewhat, but it's still 2N round
 * trips to Postgres for a roster of N salaried staff — real connection-pool
 * pressure and query-planner overhead on a restaurant with a large staff
 * list, worse under concurrent requests (every open Payroll tab repeats
 * the same N×2 queries). This does the identical computation — same
 * computeOwedAmountInPaisa/summarizeAttendance logic, not a reimplemented
 * or diverging version of it — with exactly ONE attendanceRecords query
 * (scoped to every userId in the batch via inArray, then grouped in
 * application code) and zero redundant salary lookups, since the caller
 * already has that data from its own roster query.
 *
 * Returns a Map keyed by userRoleId (matching every input entry — never
 * omits one), mirroring how the roster route already builds its
 * lastPaidByUserRoleId lookup.
 */
export async function getPayrollComputationsBatch(
  restaurantId: string,
  staff: StaffSalaryInput[],
  periodStart: string,
  periodEnd: string,
  timezone: string,
): Promise<Map<string, PayrollComputation>> {
  const result = new Map<string, PayrollComputation>();
  if (staff.length === 0) return result;

  const dayStart = restaurantStartOfDay(timezone, periodStart);
  const dayAfterEnd = new Date(restaurantStartOfDay(timezone, periodEnd).getTime() + 24 * 60 * 60 * 1000);

  const userIds = [...new Set(staff.map((s) => s.userId))];
  const records = await db
    .select({
      userId: attendanceRecords.userId,
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

  const recordsByUserId = new Map<string, { clockInAt: Date; clockOutAt: Date | null }[]>();
  for (const r of records) {
    const list = recordsByUserId.get(r.userId);
    if (list) list.push(r);
    else recordsByUserId.set(r.userId, [r]);
  }

  for (const s of staff) {
    const summary = summarizeAttendance(recordsByUserId.get(s.userId) ?? [], (d) => restaurantDate(timezone, d));
    const owedAmountInPaisa = computeOwedAmountInPaisa(s.salaryType, s.amountInPaisa, summary);
    result.set(s.userRoleId, {
      salaryType: s.salaryType,
      standingAmountInPaisa: s.amountInPaisa,
      attendanceMinutes: summary.totalMinutes,
      attendanceDays: summary.daysPresent,
      owedAmountInPaisa,
    });
  }

  return result;
}
