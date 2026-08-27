/**
 * Integration test for the payslip-generation gap closed in this pass —
 * FINAL_COMMERCIAL_READINESS.md's own "Remaining gaps" section had
 * honestly flagged "no payslip document" as the one real P1 hole; this
 * proves the new payrollPayments.deductionsJson column actually round-trips
 * through Postgres (jsonb array of {label, amountInPaisa}) the way
 * src/lib/payslip.ts's computePayslipTotals assumes it will when the API
 * route reads a row back out.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as every other
 * DB-backed integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { computePayslipTotals } from "@/lib/payslip";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("payrollPayments.deductionsJson (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let userRoleId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-payslip-${suffix}`, name: "TEST Payslip Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payslip Staff", phone: `9748${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });

    const [userRole] = await db
      .insert(schema.userRoles)
      .values({ userId: user.id, restaurantId, branchId: null, role: "waiter" })
      .returning({ id: schema.userRoles.id });
    userRoleId = userRole.id;
  });

  afterAll(async () => {
    if (!db || !schema) return;
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("stores and reads back an itemized deductions array, feeding computePayslipTotals correctly", async () => {
    const [row] = await db
      .insert(schema.payrollPayments)
      .values({
        restaurantId,
        userRoleId,
        staffNameSnapshot: "TEST Payslip Staff",
        amountInPaisa: 45_000_00,
        paymentMethod: "cash",
        deductionsJson: [
          { label: "Advance recovery", amountInPaisa: 4_000_00 },
          { label: "Uniform", amountInPaisa: 1_000_00 },
        ],
      })
      .returning();

    expect(row.deductionsJson).toEqual([
      { label: "Advance recovery", amountInPaisa: 4_000_00 },
      { label: "Uniform", amountInPaisa: 1_000_00 },
    ]);

    const totals = computePayslipTotals(row.amountInPaisa, row.deductionsJson);
    expect(totals.grossAmountInPaisa).toBe(50_000_00);
    expect(totals.netAmountInPaisa).toBe(45_000_00);
    expect(totals.totalDeductionsInPaisa).toBe(5_000_00);
  });

  it("defaults deductionsJson to null for a payment that doesn't itemize any (backward compatible)", async () => {
    const [row] = await db
      .insert(schema.payrollPayments)
      .values({
        restaurantId,
        userRoleId,
        staffNameSnapshot: "TEST Payslip Staff",
        amountInPaisa: 30_000_00,
        paymentMethod: "cash",
      })
      .returning();

    expect(row.deductionsJson).toBeNull();
    const totals = computePayslipTotals(row.amountInPaisa, row.deductionsJson);
    expect(totals.grossAmountInPaisa).toBe(30_000_00);
    expect(totals.deductions).toEqual([]);
  });
});
