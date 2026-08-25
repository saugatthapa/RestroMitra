import "server-only";
import { and, eq, gte, lt } from "drizzle-orm";
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
