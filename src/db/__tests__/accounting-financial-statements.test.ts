/**
 * Integration tests for src/lib/accounting/financial-statements.ts — Phase
 * 3's Trial Balance, Profit & Loss, and Balance Sheet. Figures below are
 * hand-calculated against a small fixed set of postings, matching the
 * plan's own Phase 3 exit criteria ("Trial Balance totals match by
 * construction", "P&L and Balance Sheet figures match hand-calculated
 * fixtures for a small set of test transactions").
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — financial statements (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let statementsLib: typeof import("@/lib/accounting/financial-statements");

  let restaurantId: string;
  let branchId: string;
  let branch2Id: string;
  let userId: string;
  let cashAccountId: string; // asset, debit-normal
  let capitalAccountId: string; // equity, credit-normal
  let salesAccountId: string; // income, credit-normal
  let salaryExpenseAccountId: string; // expense, debit-normal

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    statementsLib = await import("@/lib/accounting/financial-statements");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-statements-${suffix}`, name: "TEST Statements Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [branch2] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch 2", isMain: false })
      .returning({ id: schema.branches.id });
    branch2Id = branch2.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant 3", phone: `975${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const accounts = await db
      .insert(schema.chartOfAccounts)
      .values([
        { restaurantId, code: "T1000", name: "TEST Cash", type: "asset", normalBalance: "debit" },
        { restaurantId, code: "T3000", name: "TEST Owner Capital", type: "equity", normalBalance: "credit" },
        { restaurantId, code: "T4000", name: "TEST Sales Revenue", type: "income", normalBalance: "credit" },
        { restaurantId, code: "T5100", name: "TEST Salary Expense", type: "expense", normalBalance: "debit" },
      ])
      .returning({ id: schema.chartOfAccounts.id, code: schema.chartOfAccounts.code });
    cashAccountId = accounts.find((a) => a.code === "T1000")!.id;
    capitalAccountId = accounts.find((a) => a.code === "T3000")!.id;
    salesAccountId = accounts.find((a) => a.code === "T4000")!.id;
    salaryExpenseAccountId = accounts.find((a) => a.code === "T5100")!.id;

    const post = (
      voucherDate: string,
      lines: Parameters<typeof postVoucherLib.postVoucher>[1]["lines"],
      postBranchId: string = branchId,
    ) =>
      db.transaction((tx) =>
        postVoucherLib.postVoucher(tx, {
          restaurantId,
          branchId: postBranchId,
          voucherType: "journal",
          voucherDate,
          createdByUserId: userId,
          lines,
        }),
      );

    // Owner invests 1000 (Jan 1).
    await post("2025-01-01", [
      { accountId: cashAccountId, debitInPaisa: 1000_00 },
      { accountId: capitalAccountId, creditInPaisa: 1000_00 },
    ]);
    // A 500 sale (Jan 10).
    await post("2025-01-10", [
      { accountId: cashAccountId, debitInPaisa: 500_00 },
      { accountId: salesAccountId, creditInPaisa: 500_00 },
    ]);
    // A 200 salary expense paid in cash (Jan 15).
    await post("2025-01-15", [
      { accountId: salaryExpenseAccountId, debitInPaisa: 200_00 },
      { accountId: cashAccountId, creditInPaisa: 200_00 },
    ]);
    // A second, later 300 sale (Feb 1) — outside the Jan-only report window
    // used by some assertions below, to prove date filtering actually works.
    await post("2025-02-01", [
      { accountId: cashAccountId, debitInPaisa: 300_00 },
      { accountId: salesAccountId, creditInPaisa: 300_00 },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("Trial Balance as of Jan 31 matches by construction and by hand-calculation", async () => {
    const tb = await statementsLib.getTrialBalance({ restaurantId, asOfDate: "2025-01-31" });

    const rowFor = (accountId: string) => tb.rows.find((r) => r.accountId === accountId);
    // Cash: +1000 +500 -200 = 1300, debit-normal positive -> debit column.
    expect(rowFor(cashAccountId)?.debitInPaisa).toBe(1300_00);
    expect(rowFor(cashAccountId)?.creditInPaisa).toBe(0);
    // Owner Capital: 1000, credit-normal positive -> credit column.
    expect(rowFor(capitalAccountId)?.creditInPaisa).toBe(1000_00);
    // Sales Revenue (Jan only, the Feb sale is excluded): 500.
    expect(rowFor(salesAccountId)?.creditInPaisa).toBe(500_00);
    // Salary Expense: 200, debit-normal -> debit column.
    expect(rowFor(salaryExpenseAccountId)?.debitInPaisa).toBe(200_00);

    expect(tb.totalDebitInPaisa).toBe(1500_00);
    expect(tb.totalCreditInPaisa).toBe(1500_00);
    expect(tb.isBalanced).toBe(true);
  });

  it("Profit & Loss for January only excludes the February sale", async () => {
    const pnl = await statementsLib.getProfitAndLoss({
      restaurantId,
      fromDate: "2025-01-01",
      toDate: "2025-01-31",
    });

    expect(pnl.totalIncomeInPaisa).toBe(500_00);
    expect(pnl.totalExpenseInPaisa).toBe(200_00);
    expect(pnl.netIncomeInPaisa).toBe(300_00);
  });

  it("Profit & Loss since inception includes both sales", async () => {
    const pnl = await statementsLib.getProfitAndLoss({ restaurantId });

    expect(pnl.totalIncomeInPaisa).toBe(800_00);
    expect(pnl.totalExpenseInPaisa).toBe(200_00);
    expect(pnl.netIncomeInPaisa).toBe(600_00);
  });

  it("Balance Sheet as of Jan 31 balances via the Current Period Earnings line", async () => {
    const bs = await statementsLib.getBalanceSheet({ restaurantId, asOfDate: "2025-01-31" });

    expect(bs.totalAssetsInPaisa).toBe(1300_00);
    expect(bs.totalLiabilitiesInPaisa).toBe(0);
    // Owner Capital (1000) + Current Period Earnings (300, Jan's net income).
    expect(bs.currentPeriodEarningsInPaisa).toBe(300_00);
    expect(bs.totalEquityInPaisa).toBe(1300_00);
    expect(bs.isBalanced).toBe(true);
  });

  it("Balance Sheet as of Feb 28 rolls the February sale into Current Period Earnings", async () => {
    const bs = await statementsLib.getBalanceSheet({ restaurantId, asOfDate: "2025-02-28" });

    expect(bs.totalAssetsInPaisa).toBe(1600_00);
    expect(bs.currentPeriodEarningsInPaisa).toBe(600_00);
    expect(bs.totalEquityInPaisa).toBe(1600_00);
    expect(bs.isBalanced).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Phase 7, Slice 7b — branch-scoped reports. Posts one more voucher, on
  // Branch 2, AFTER every assertion above that depends on the original
  // fixture's exact restaurant-wide totals — deliberately sequenced last
  // in this file so it never perturbs those already-passing figures.
  // ---------------------------------------------------------------------

  it("a branch-scoped Profit & Loss excludes another branch's own sale, while the unfiltered report includes both", async () => {
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId: branch2Id,
        voucherType: "journal",
        voucherDate: "2025-03-05",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 150_00 },
          { accountId: salesAccountId, creditInPaisa: 150_00 },
        ],
      }),
    );

    const branch1Pnl = await statementsLib.getProfitAndLoss({
      restaurantId,
      fromDate: "2025-03-01",
      toDate: "2025-03-31",
      branchId,
    });
    expect(branch1Pnl.totalIncomeInPaisa).toBe(0);
    expect(branch1Pnl.branchId).toBe(branchId);

    const branch2Pnl = await statementsLib.getProfitAndLoss({
      restaurantId,
      fromDate: "2025-03-01",
      toDate: "2025-03-31",
      branchId: branch2Id,
    });
    expect(branch2Pnl.totalIncomeInPaisa).toBe(150_00);

    const unfilteredPnl = await statementsLib.getProfitAndLoss({
      restaurantId,
      fromDate: "2025-03-01",
      toDate: "2025-03-31",
    });
    expect(unfilteredPnl.totalIncomeInPaisa).toBe(150_00);
    expect(unfilteredPnl.branchId).toBeNull();
  });

  it("getBranchProfitability breaks March's P&L out per branch, summing to the unfiltered total", async () => {
    const report = await statementsLib.getBranchProfitability({
      restaurantId,
      fromDate: "2025-03-01",
      toDate: "2025-03-31",
    });

    expect(report.branches).toHaveLength(2);
    const main = report.branches.find((b) => b.branchId === branchId)!;
    const branch2 = report.branches.find((b) => b.branchId === branch2Id)!;
    expect(main.totalIncomeInPaisa).toBe(0);
    expect(branch2.totalIncomeInPaisa).toBe(150_00);
    expect(main.isMain).toBe(true);
    expect(branch2.isMain).toBe(false);

    const restricted = await statementsLib.getBranchProfitability({
      restaurantId,
      fromDate: "2025-03-01",
      toDate: "2025-03-31",
      restrictToBranchIds: [branch2Id],
    });
    expect(restricted.branches).toHaveLength(1);
    expect(restricted.branches[0].branchId).toBe(branch2Id);
  });
});
