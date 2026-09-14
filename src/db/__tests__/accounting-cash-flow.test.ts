/**
 * Integration tests for src/lib/accounting/cash-flow.ts — Phase 5, Slice
 * 5c's indirect-method Cash Flow Statement. Per the plan's own test plan
 * for this slice: a restaurant with a full period of sales/expense/
 * payroll/loan/asset activity, asserting the statement's computed ending
 * cash position matches the sum of all bank/cash account balances exactly
 * (the `isReconciled` flag — see cash-flow.ts's own top-of-file comment).
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — cash flow statement (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let fixedAssetsLib: typeof import("@/lib/accounting/fixed-assets");
  let loansLib: typeof import("@/lib/accounting/loans");
  let cashFlowLib: typeof import("@/lib/accounting/cash-flow");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let cashAccountId: string;
  let salesRevenueAccountId: string;
  let cogsAccountId: string;
  let salaryExpenseAccountId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    fixedAssetsLib = await import("@/lib/accounting/fixed-assets");
    loansLib = await import("@/lib/accounting/loans");
    cashFlowLib = await import("@/lib/accounting/cash-flow");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cash-flow-${suffix}`, name: "TEST Cash Flow Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Cash Flow Accountant", phone: `977${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    const seeded = await db
      .select({ id: schema.chartOfAccounts.id, code: schema.chartOfAccounts.code })
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.restaurantId, restaurantId));
    const byCode = new Map(seeded.map((a) => [a.code, a.id]));
    cashAccountId = byCode.get("1000")!;
    salesRevenueAccountId = byCode.get("4000")!;
    cogsAccountId = byCode.get("5000")!;
    salaryExpenseAccountId = byCode.get("5100")!;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("classifies a full month of sales/expense/payroll/loan/asset activity into operating/investing/financing, reconciling exactly to the actual cash balance change", async () => {
    // Operating: a cash sale (+50,000), a cash expense (-10,000), a payroll
    // payout (-8,000).
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-05-05",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 50_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 50_000_00 },
        ],
      }),
    );
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "expense",
        voucherDate: "2026-05-10",
        createdByUserId: userId,
        lines: [
          { accountId: cogsAccountId, debitInPaisa: 10_000_00 },
          { accountId: cashAccountId, creditInPaisa: 10_000_00 },
        ],
      }),
    );
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "payroll",
        voucherDate: "2026-05-28",
        createdByUserId: userId,
        lines: [
          { accountId: salaryExpenseAccountId, debitInPaisa: 8_000_00 },
          { accountId: cashAccountId, creditInPaisa: 8_000_00 },
        ],
      }),
    );

    // Investing: a cash-funded fixed asset acquisition (-20,000).
    await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: "TEST Cash Flow Oven",
        acquisitionDate: "2026-05-12",
        costInPaisa: 20_000_00,
        usefulLifeMonths: 60,
        salvageValueInPaisa: 0,
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    // Financing: a loan receipt (+100,000) and one repayment split into
    // principal (-5,000, financing) and interest (-1,000, operating).
    const { loan } = await db.transaction((tx) =>
      loansLib.recordLoanReceipt(tx, {
        restaurantId,
        branchId,
        lenderName: "TEST Cash Flow Lender",
        principalInPaisa: 100_000_00,
        startDate: "2026-05-15",
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );
    await db.transaction((tx) =>
      loansLib.recordLoanRepayment(tx, {
        restaurantId,
        branchId,
        loanId: loan.id,
        paymentDate: "2026-05-20",
        principalInPaisa: 5_000_00,
        interestInPaisa: 1_000_00,
        paymentMethod: "cash",
        createdByUserId: userId,
      }),
    );

    const statement = await cashFlowLib.getCashFlowStatement({
      restaurantId,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
    });

    expect(statement.beginningCashInPaisa).toBe(0);
    // 50,000 - 10,000 - 8,000 - 20,000 + 100,000 - 5,000 - 1,000 = 106,000
    expect(statement.endingCashInPaisa).toBe(106_000_00);

    expect(statement.operating.totalInPaisa).toBe(50_000_00 - 10_000_00 - 8_000_00 - 1_000_00);
    expect(statement.investing.totalInPaisa).toBe(-20_000_00);
    expect(statement.financing.totalInPaisa).toBe(100_000_00 - 5_000_00);

    expect(statement.netChangeInCashInPaisa).toBe(106_000_00);
    expect(statement.isReconciled).toBe(true);

    // Operating's own indirect-style lines must sum to exactly the same
    // (already-verified) operating total — the plug never leaves a gap.
    const operatingLineSum = statement.operating.lines.reduce((s, l) => s + l.amountInPaisa, 0);
    expect(operatingLineSum).toBe(statement.operating.totalInPaisa);

    const investingLineSum = statement.investing.lines.reduce((s, l) => s + l.amountInPaisa, 0);
    expect(investingLineSum).toBe(statement.investing.totalInPaisa);
    const financingLineSum = statement.financing.lines.reduce((s, l) => s + l.amountInPaisa, 0);
    expect(financingLineSum).toBe(statement.financing.totalInPaisa);
  });

  it("excludes a credit-funded fixed asset acquisition from Investing entirely (no cash line ever posted)", async () => {
    const before = await cashFlowLib.getCashFlowStatement({
      restaurantId,
      fromDate: "2026-06-01",
      toDate: "2026-06-30",
    });
    expect(before.investing.totalInPaisa).toBe(0);

    await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: "TEST Credit-Funded Fridge",
        acquisitionDate: "2026-06-10",
        costInPaisa: 15_000_00,
        usefulLifeMonths: 36,
        salvageValueInPaisa: 0,
        fundingMethod: "credit",
        createdByUserId: userId,
      }),
    );

    const after = await cashFlowLib.getCashFlowStatement({
      restaurantId,
      fromDate: "2026-06-01",
      toDate: "2026-06-30",
    });
    // No cash moved — Accounts Payable was credited instead — so this
    // acquisition contributes nothing to Investing.
    expect(after.investing.totalInPaisa).toBe(0);
    expect(after.isReconciled).toBe(true);
  });

  it("a loan receipt with no repayment in the period is entirely Financing, with no Operating interest contribution", async () => {
    await db.transaction((tx) =>
      loansLib.recordLoanReceipt(tx, {
        restaurantId,
        branchId,
        lenderName: "TEST July Lender",
        principalInPaisa: 30_000_00,
        startDate: "2026-07-05",
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    const statement = await cashFlowLib.getCashFlowStatement({
      restaurantId,
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
    });
    expect(statement.financing.totalInPaisa).toBe(30_000_00);
    expect(statement.operating.totalInPaisa).toBe(0);
    expect(statement.isReconciled).toBe(true);
  });
});
