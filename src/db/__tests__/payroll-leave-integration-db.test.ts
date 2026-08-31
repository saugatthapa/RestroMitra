/**
 * Phase 16 (Attendance overhaul, Track B — Analytics & payroll integration)
 * — DB-integration tests proving the two payroll.ts extensions this phase
 * adds: (1) a "rejected" attendance record no longer counts toward
 * attendanceDays/attendanceMinutes/pay, and (2) approved, non-unpaid leave
 * days within the period are folded into a "daily" salary's
 * owedAmountInPaisa (and merely surfaced, not folded in, for "hourly").
 * Deliberately a separate file from payroll-computation.test.ts (which
 * predates this phase) rather than inserted into it, so this phase's own
 * scope is self-contained and easy to review/revert independently.
 *
 * Skipped (not failed) when DATABASE_URL isn't set — same convention as
 * every other DB-integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Payroll × leave/rejected-attendance integration (Phase 16)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let payroll: typeof import("@/lib/payroll");

  let restaurantId: string;
  let userId: string;
  let userRoleId: string;

  const TZ = "UTC";

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    payroll = await import("@/lib/payroll");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-payroll-leave-${suffix}`, name: "TEST Payroll Leave Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payroll Leave User", phone: `979${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [role] = await db
      .insert(schema.userRoles)
      .values({ userId, restaurantId, role: "waiter" })
      .returning({ id: schema.userRoles.id });
    userRoleId = role.id;
  });

  afterAll(async () => {
    await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.restaurantId, restaurantId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
    await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function setSalary(salaryType: "daily" | "hourly", amountInPaisa: number) {
    await db.insert(schema.staffSalaryConfigs).values({ userRoleId, restaurantId, salaryType, amountInPaisa });
  }

  async function clockIn(clockInAt: Date, clockOutAt: Date, status: "needs_review" | "verified" | "rejected") {
    await db.insert(schema.attendanceRecords).values({ restaurantId, userId, clockInAt, clockOutAt, status });
  }

  async function requestLeave(
    leaveType: "sick" | "casual" | "unpaid" | "other",
    status: "pending" | "approved" | "rejected" | "cancelled",
    startDate: string,
    endDate: string,
  ) {
    await db.insert(schema.leaveRequests).values({ restaurantId, userId, leaveType, status, startDate, endDate });
  }

  describe("computeOwedAmountInPaisa (pure) — paidLeaveDays", () => {
    it("daily: folds paidLeaveDays into the days multiplier", () => {
      expect(
        payroll.computeOwedAmountInPaisa("daily", 500_00, { totalMinutes: 0, daysPresent: 3, paidLeaveDays: 2 }),
      ).toBe(2_500_00); // (3 + 2) days * Rs500
    });

    it("daily: omitted paidLeaveDays behaves exactly as before this phase (defaults to 0)", () => {
      expect(payroll.computeOwedAmountInPaisa("daily", 500_00, { totalMinutes: 0, daysPresent: 3 })).toBe(1_500_00);
    });

    it("hourly: paidLeaveDays does NOT affect the computed amount", () => {
      const withoutLeave = payroll.computeOwedAmountInPaisa("hourly", 100_00, { totalMinutes: 120, daysPresent: 1 });
      const withLeave = payroll.computeOwedAmountInPaisa("hourly", 100_00, {
        totalMinutes: 120,
        daysPresent: 1,
        paidLeaveDays: 5,
      });
      expect(withLeave).toBe(withoutLeave);
    });

    it("monthly: paidLeaveDays does NOT affect the computed amount", () => {
      expect(payroll.computeOwedAmountInPaisa("monthly", 30_000_00, { totalMinutes: 0, daysPresent: 0, paidLeaveDays: 10 })).toBe(
        30_000_00,
      );
    });
  });

  describe("getPayrollComputation (integration)", () => {
    it("excludes a rejected attendance record from attendanceDays/attendanceMinutes/pay", async () => {
      await setSalary("daily", 500_00);

      // Two counted shifts (needs_review + verified) plus one rejected
      // shift on a THIRD distinct day — the rejected day must not show up
      // in attendanceDays at all.
      await clockIn(new Date("2026-08-03T09:00:00Z"), new Date("2026-08-03T17:00:00Z"), "needs_review");
      await clockIn(new Date("2026-08-04T09:00:00Z"), new Date("2026-08-04T17:00:00Z"), "verified");
      await clockIn(new Date("2026-08-05T09:00:00Z"), new Date("2026-08-05T17:00:00Z"), "rejected");

      const result = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-08-01", "2026-08-31", TZ);
      expect(result!.attendanceDays).toBe(2);
      expect(result!.owedAmountInPaisa).toBe(1_000_00); // 2 counted days * Rs500, rejected day excluded

      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
    });

    it("daily: folds approved, non-unpaid leave days within the period into owedAmountInPaisa", async () => {
      await setSalary("daily", 500_00);

      // One counted attended day.
      await clockIn(new Date("2026-09-03T09:00:00Z"), new Date("2026-09-03T17:00:00Z"), "verified");

      // Approved sick leave, 2 days, fully inside the period -> counted.
      await requestLeave("sick", "approved", "2026-09-10", "2026-09-11");
      // Approved but UNPAID leave -> must NOT count.
      await requestLeave("unpaid", "approved", "2026-09-12", "2026-09-12");
      // Still-PENDING casual leave -> must NOT count (not decided yet).
      await requestLeave("casual", "pending", "2026-09-13", "2026-09-13");
      // Approved leave spanning outside the period on one side -> clipped
      // to only the days that fall inside [2026-09-01, 2026-09-30].
      await requestLeave("sick", "approved", "2026-08-29", "2026-09-01");

      const result = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-09-01", "2026-09-30", TZ);
      expect(result!.attendanceDays).toBe(1);
      expect(result!.paidLeaveDays).toBe(3); // 2 (sick, fully inside) + 1 (clipped sick)
      expect(result!.owedAmountInPaisa).toBe(2_000_00); // (1 attended + 3 leave) * Rs500

      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
      await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userId));
    });

    it("hourly: paidLeaveDays is surfaced but NOT folded into owedAmountInPaisa", async () => {
      await setSalary("hourly", 100_00);

      await clockIn(new Date("2026-10-03T09:00:00Z"), new Date("2026-10-03T11:00:00Z"), "verified"); // 2h
      await requestLeave("sick", "approved", "2026-10-10", "2026-10-11"); // 2 days

      const result = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-10-01", "2026-10-31", TZ);
      expect(result!.paidLeaveDays).toBe(2);
      expect(result!.owedAmountInPaisa).toBe(200_00); // 2h * Rs100/hr, leave not folded in

      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
      await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userId));
    });
  });

  describe("getPayrollComputationsBatch (integration) — matches getPayrollComputation exactly", () => {
    it("rejected-exclusion and paid-leave-days both match the single-person computation", async () => {
      await setSalary("daily", 500_00);

      await clockIn(new Date("2026-11-03T09:00:00Z"), new Date("2026-11-03T17:00:00Z"), "verified");
      await clockIn(new Date("2026-11-04T09:00:00Z"), new Date("2026-11-04T17:00:00Z"), "rejected");
      await requestLeave("casual", "approved", "2026-11-10", "2026-11-10");

      const individual = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-11-01", "2026-11-30", TZ);
      const batch = await payroll.getPayrollComputationsBatch(
        restaurantId,
        [{ userRoleId, userId, salaryType: "daily", amountInPaisa: 500_00 }],
        "2026-11-01",
        "2026-11-30",
        TZ,
      );

      expect(batch.get(userRoleId)).toEqual(individual);
      expect(batch.get(userRoleId)!.attendanceDays).toBe(1);
      expect(batch.get(userRoleId)!.paidLeaveDays).toBe(1);
      expect(batch.get(userRoleId)!.owedAmountInPaisa).toBe(1_000_00);

      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
      await db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userId));
    });
  });
});
