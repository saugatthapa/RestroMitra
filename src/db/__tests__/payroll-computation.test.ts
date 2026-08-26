/**
 * Commercial-launch Phase B.2 (Payroll Upgrades) integration tests for
 * src/lib/payroll.ts's computeOwedAmountInPaisa/getPayrollComputation —
 * wiring attendanceRecords into a payroll amount for the first time.
 *
 * Fixture attendance rows are inserted with explicit clockInAt/clockOutAt
 * timestamps so hours/days-worked totals are exact, hand-computed values.
 * TZ is "UTC" throughout (same convention as order-performance.test.ts)
 * so restaurantStartOfDay/restaurantDate behave like plain UTC-calendar
 * math, keeping the day-boundary tests easy to reason about.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Payroll computation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let payroll: typeof import("@/lib/payroll");

  let restaurantId: string;
  let otherRestaurantId: string;
  let userId: string;
  let userRoleId: string;
  let otherUserRoleId: string;
  // A second real staff member in the SAME restaurant, used only by the
  // getPayrollComputationsBatch tests below — batching only says anything
  // interesting with more than one person in the batch.
  let userId2: string;
  let userRoleId2: string;

  const TZ = "UTC";

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    payroll = await import("@/lib/payroll");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-payroll-comp-${suffix}`, name: "TEST Payroll Computation Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-payroll-comp-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payroll Comp User", phone: `977${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [role] = await db
      .insert(schema.userRoles)
      .values({ userId, restaurantId, role: "waiter" })
      .returning({ id: schema.userRoles.id });
    userRoleId = role.id;

    const [otherRole] = await db
      .insert(schema.userRoles)
      .values({ userId, restaurantId: otherRestaurantId, role: "waiter" })
      .returning({ id: schema.userRoles.id });
    otherUserRoleId = otherRole.id;

    const [user2] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payroll Comp User 2", phone: `978${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId2 = user2.id;

    const [role2] = await db
      .insert(schema.userRoles)
      .values({ userId: userId2, restaurantId, role: "waiter" })
      .returning({ id: schema.userRoles.id });
    userRoleId2 = role2.id;
  });

  afterAll(async () => {
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
    await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.restaurantId, restaurantId));
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, otherRestaurantId));
    await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.restaurantId, otherRestaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, otherRestaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId2));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  async function setSalary(
    targetUserRoleId: string,
    targetRestaurantId: string,
    salaryType: "monthly" | "daily" | "hourly",
    amountInPaisa: number,
  ) {
    await db.insert(schema.staffSalaryConfigs).values({
      userRoleId: targetUserRoleId,
      restaurantId: targetRestaurantId,
      salaryType,
      amountInPaisa,
    });
  }

  async function clockIn(
    targetUserId: string,
    targetRestaurantId: string,
    clockInAt: Date,
    clockOutAt: Date | null,
  ) {
    await db.insert(schema.attendanceRecords).values({
      restaurantId: targetRestaurantId,
      userId: targetUserId,
      clockInAt,
      clockOutAt,
    });
  }

  describe("computeOwedAmountInPaisa (pure)", () => {
    it("monthly: returns the full standing amount regardless of attendance", () => {
      expect(payroll.computeOwedAmountInPaisa("monthly", 5_000_00, { totalMinutes: 0, daysPresent: 0 })).toBe(5_000_00);
      expect(payroll.computeOwedAmountInPaisa("monthly", 5_000_00, { totalMinutes: 999_999, daysPresent: 30 })).toBe(5_000_00);
    });

    it("daily: rate × distinct days present", () => {
      expect(payroll.computeOwedAmountInPaisa("daily", 1_000_00, { totalMinutes: 0, daysPresent: 4 })).toBe(4_000_00);
    });

    it("hourly: rate × hours worked, rounded to the nearest paisa", () => {
      // 90 minutes = 1.5 hours at Rs 200/hr = Rs 300 exactly.
      expect(payroll.computeOwedAmountInPaisa("hourly", 200_00, { totalMinutes: 90, daysPresent: 1 })).toBe(300_00);
      // 100 minutes at Rs 100/hr = Rs 166.666... -> rounds to nearest paisa.
      expect(payroll.computeOwedAmountInPaisa("hourly", 100_00, { totalMinutes: 100, daysPresent: 1 })).toBe(
        Math.round((100_00 * 100) / 60),
      );
    });

    it("zero-attendance edge case: daily/hourly both owe zero", () => {
      expect(payroll.computeOwedAmountInPaisa("daily", 1_000_00, { totalMinutes: 0, daysPresent: 0 })).toBe(0);
      expect(payroll.computeOwedAmountInPaisa("hourly", 200_00, { totalMinutes: 0, daysPresent: 0 })).toBe(0);
    });
  });

  describe("getPayrollComputation (integration)", () => {
    it("no-salary-config edge case: returns null when nothing is configured", async () => {
      const result = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-02-01", "2026-02-28", TZ);
      expect(result).toBeNull();
    });

    it("happy path (hourly): sums minutes across shifts in range and computes the owed amount", async () => {
      await setSalary(userRoleId, restaurantId, "hourly", 150_00); // Rs 150/hr

      // Two shifts inside the period: 3h and 2h = 5h total.
      await clockIn(userId, restaurantId, new Date("2026-03-02T09:00:00Z"), new Date("2026-03-02T12:00:00Z"));
      await clockIn(userId, restaurantId, new Date("2026-03-03T09:00:00Z"), new Date("2026-03-03T11:00:00Z"));

      const result = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-03-01", "2026-03-07", TZ);
      expect(result).not.toBeNull();
      expect(result!.salaryType).toBe("hourly");
      expect(result!.standingAmountInPaisa).toBe(150_00);
      expect(result!.attendanceMinutes).toBe(300);
      expect(result!.attendanceDays).toBe(2);
      expect(result!.owedAmountInPaisa).toBe(750_00); // 5h * Rs150

      // Cleanup so later tests in this file (which reuse the same
      // userRoleId/restaurant) start from a clean salary config.
      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
    });

    it("happy path (daily): counts distinct calendar days, not shift count", async () => {
      await setSalary(userRoleId, restaurantId, "daily", 800_00);

      // Two shifts on the SAME calendar day should count as 1 day present.
      await clockIn(userId, restaurantId, new Date("2026-04-05T05:00:00Z"), new Date("2026-04-05T09:00:00Z"));
      await clockIn(userId, restaurantId, new Date("2026-04-05T13:00:00Z"), new Date("2026-04-05T17:00:00Z"));
      await clockIn(userId, restaurantId, new Date("2026-04-06T05:00:00Z"), new Date("2026-04-06T09:00:00Z"));

      const result = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-04-01", "2026-04-30", TZ);
      expect(result!.attendanceDays).toBe(2);
      expect(result!.owedAmountInPaisa).toBe(1_600_00); // 2 days * Rs800

      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
    });

    it("open (still-clocked-in) shift counts live duration up to now", async () => {
      await setSalary(userRoleId, restaurantId, "hourly", 100_00);

      // Clocked in 1 hour ago, never clocked out.
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await clockIn(userId, restaurantId, oneHourAgo, null);

      const today = new Date().toISOString().slice(0, 10);
      const result = await payroll.getPayrollComputation(restaurantId, userRoleId, today, today, TZ);
      // Roughly 60 minutes — allow slack for test execution time.
      expect(result!.attendanceMinutes).toBeGreaterThanOrEqual(59);
      expect(result!.attendanceMinutes).toBeLessThanOrEqual(65);
      expect(result!.owedAmountInPaisa).toBeGreaterThan(0);

      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
    });

    it("boundary: a shift is attributed to its clock-in day even when clock-out spills past the period end", async () => {
      await setSalary(userRoleId, restaurantId, "daily", 500_00);

      // Clocks in the last minute of the period, clocks out well after it.
      await clockIn(
        userId,
        restaurantId,
        new Date("2026-05-10T23:59:00Z"),
        new Date("2026-05-11T02:00:00Z"),
      );

      const result = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-05-10", "2026-05-10", TZ);
      // The whole shift (including the portion after midnight) counts,
      // since inclusion is decided by clockInAt alone, never clockOutAt.
      expect(result!.attendanceDays).toBe(1);
      expect(result!.attendanceMinutes).toBe(121);
      expect(result!.owedAmountInPaisa).toBe(500_00);

      // A shift that clocks IN outside the period (even by one day) must
      // NOT be picked up at all.
      const outsideResult = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-05-11", "2026-05-11", TZ);
      expect(outsideResult!.attendanceDays).toBe(0);
      expect(outsideResult!.owedAmountInPaisa).toBe(0);

      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
    });

    it("wrong-restaurant / wrong-userRoleId isolation: never mixes another restaurant's or role's data", async () => {
      await setSalary(userRoleId, restaurantId, "daily", 500_00);
      await setSalary(otherUserRoleId, otherRestaurantId, "daily", 999_00);

      await clockIn(userId, restaurantId, new Date("2026-06-01T08:00:00Z"), new Date("2026-06-01T16:00:00Z"));
      // Same physical user, but a shift logged under the OTHER restaurant.
      await clockIn(userId, otherRestaurantId, new Date("2026-06-01T08:00:00Z"), new Date("2026-06-01T16:00:00Z"));

      // Querying with the right userRoleId but WRONG restaurantId must
      // find no salary config (userRoles scoped by restaurant) -> null.
      const wrongRestaurant = await payroll.getPayrollComputation(otherRestaurantId, userRoleId, "2026-06-01", "2026-06-01", TZ);
      expect(wrongRestaurant).toBeNull();

      // Querying the correct restaurant/userRoleId only counts that
      // restaurant's own attendance record for this user, not the other
      // restaurant's identically-timed shift.
      const ownResult = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-06-01", "2026-06-01", TZ);
      expect(ownResult!.attendanceDays).toBe(1);
      expect(ownResult!.owedAmountInPaisa).toBe(500_00);

      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, otherUserRoleId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
    });
  });

  // QA hardening pass (Phase 27 / performance audit) —
  // getPayrollComputationsBatch is the batched sibling wired into the
  // payroll roster route (payroll/staff/route.ts) to replace one
  // getPayrollComputation() call per staff member with a single query for
  // the whole roster. These tests prove the batched path produces IDENTICAL
  // results to calling getPayrollComputation() once per person — same
  // computation, just fewer round trips — plus its own isolation/edge
  // cases (multiple people in one batch, an empty batch, a person with no
  // attendance in range still getting a zeroed entry).
  describe("getPayrollComputationsBatch (integration)", () => {
    it("empty batch: returns an empty Map without querying anything", async () => {
      const result = await payroll.getPayrollComputationsBatch(restaurantId, [], "2026-07-01", "2026-07-31", TZ);
      expect(result.size).toBe(0);
    });

    it("matches getPayrollComputation() exactly for each person in a multi-person batch, and isolates attendance per user", async () => {
      await setSalary(userRoleId, restaurantId, "hourly", 150_00);
      await setSalary(userRoleId2, restaurantId, "daily", 800_00);

      // userRoleId: two shifts, 3h + 2h = 5h.
      await clockIn(userId, restaurantId, new Date("2026-07-02T09:00:00Z"), new Date("2026-07-02T12:00:00Z"));
      await clockIn(userId, restaurantId, new Date("2026-07-03T09:00:00Z"), new Date("2026-07-03T11:00:00Z"));
      // userRoleId2: two shifts on two distinct days.
      await clockIn(userId2, restaurantId, new Date("2026-07-04T05:00:00Z"), new Date("2026-07-04T09:00:00Z"));
      await clockIn(userId2, restaurantId, new Date("2026-07-05T05:00:00Z"), new Date("2026-07-05T09:00:00Z"));

      const batch = await payroll.getPayrollComputationsBatch(
        restaurantId,
        [
          { userRoleId, userId, salaryType: "hourly", amountInPaisa: 150_00 },
          { userRoleId: userRoleId2, userId: userId2, salaryType: "daily", amountInPaisa: 800_00 },
        ],
        "2026-07-01",
        "2026-07-31",
        TZ,
      );

      const individual1 = await payroll.getPayrollComputation(restaurantId, userRoleId, "2026-07-01", "2026-07-31", TZ);
      const individual2 = await payroll.getPayrollComputation(restaurantId, userRoleId2, "2026-07-01", "2026-07-31", TZ);

      expect(batch.size).toBe(2);
      expect(batch.get(userRoleId)).toEqual(individual1);
      expect(batch.get(userRoleId2)).toEqual(individual2);
      // Sanity on the actual figures, not just "matches the other function"
      // (which could both be wrong the same way).
      expect(batch.get(userRoleId)!.attendanceMinutes).toBe(300);
      expect(batch.get(userRoleId)!.owedAmountInPaisa).toBe(750_00);
      expect(batch.get(userRoleId2)!.attendanceDays).toBe(2);
      expect(batch.get(userRoleId2)!.owedAmountInPaisa).toBe(1_600_00);

      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId));
      await db.delete(schema.staffSalaryConfigs).where(eq(schema.staffSalaryConfigs.userRoleId, userRoleId2));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId2));
    });

    it("a person with no attendance in range still gets a zeroed (never omitted) entry in the returned Map", async () => {
      const batch = await payroll.getPayrollComputationsBatch(
        restaurantId,
        [{ userRoleId, userId, salaryType: "daily", amountInPaisa: 500_00 }],
        "2026-08-01",
        "2026-08-31",
        TZ,
      );
      expect(batch.has(userRoleId)).toBe(true);
      expect(batch.get(userRoleId)!.attendanceDays).toBe(0);
      expect(batch.get(userRoleId)!.owedAmountInPaisa).toBe(0);
    });

    it("wrong-restaurant isolation: a same-physical-user shift logged under a DIFFERENT restaurant is never picked up", async () => {
      // Same physical user (userId), but one shift under `restaurantId`
      // and an identically-timed one under `otherRestaurantId` — mirrors
      // getPayrollComputation's own isolation test above.
      await clockIn(userId, restaurantId, new Date("2026-09-01T08:00:00Z"), new Date("2026-09-01T16:00:00Z"));
      await clockIn(userId, otherRestaurantId, new Date("2026-09-01T08:00:00Z"), new Date("2026-09-01T16:00:00Z"));

      const batch = await payroll.getPayrollComputationsBatch(
        restaurantId,
        [{ userRoleId, userId, salaryType: "daily", amountInPaisa: 500_00 }],
        "2026-09-01",
        "2026-09-01",
        TZ,
      );
      expect(batch.get(userRoleId)!.attendanceDays).toBe(1);
      expect(batch.get(userRoleId)!.owedAmountInPaisa).toBe(500_00);

      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.userId, userId));
    });
  });
});
