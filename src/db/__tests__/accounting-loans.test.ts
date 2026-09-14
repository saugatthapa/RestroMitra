/**
 * Integration tests for src/lib/accounting/loans.ts — Phase 5, Slice 5e's
 * loan receipt and manual-split repayment (see that module's own doc
 * comments for the full reasoning this test suite exercises).
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — loans (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let loansLib: typeof import("@/lib/accounting/loans");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let cashAccountId: string;
  let interestExpenseAccountId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    loansLib = await import("@/lib/accounting/loans");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-loans-${suffix}`, name: "TEST Loans Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Loans Accountant", phone: `977${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    const seeded = await db
      .select({ id: schema.chartOfAccounts.id, code: schema.chartOfAccounts.code })
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.restaurantId, restaurantId));
    const byCode = new Map(seeded.map((a) => [a.code, a.id]));
    cashAccountId = byCode.get("1000")!;
    interestExpenseAccountId = byCode.get("5160")!;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("recordLoanReceipt (cash) provisions a child account under 2400 in the reserved 2401-2499 block and posts a balanced voucher", async () => {
    const { loan, voucher } = await db.transaction((tx) =>
      loansLib.recordLoanReceipt(tx, {
        restaurantId,
        branchId,
        lenderName: "TEST Bank of Kathmandu",
        principalInPaisa: 500_000_00,
        interestRateBasisPoints: 1250,
        startDate: "2026-01-01",
        termMonths: 24,
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    expect(Number(loan.code)).toBeGreaterThanOrEqual(2401);
    expect(Number(loan.code)).toBeLessThanOrEqual(2499);
    expect(loan.outstandingPrincipalInPaisa).toBe(500_000_00);
    expect(loan.status).toBe("active");

    const [account] = await db
      .select()
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.id, loan.chartOfAccountsId));
    expect(account.type).toBe("liability");
    expect(account.normalBalance).toBe("credit");

    const [parent] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, "2400")));
    expect(account.parentAccountId).toBe(parent.id);

    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    expect(lines.length).toBe(2);
    const cashLine = lines.find((l) => l.accountId === cashAccountId)!;
    const loanLine = lines.find((l) => l.accountId === loan.chartOfAccountsId)!;
    expect(cashLine.debitInPaisa).toBe(500_000_00);
    expect(loanLine.creditInPaisa).toBe(500_000_00);
  });

  it("rejects a non-positive principal before touching the database", async () => {
    await expect(
      db.transaction((tx) =>
        loansLib.recordLoanReceipt(tx, {
          restaurantId,
          branchId,
          lenderName: "TEST Bad Lender",
          principalInPaisa: 0,
          startDate: "2026-01-01",
          fundingMethod: "cash",
          createdByUserId: userId,
        }),
      ),
    ).rejects.toThrow(/principal must be/i);
  });

  it("recordLoanRepayment splits principal and interest into separate lines and decrements the outstanding balance", async () => {
    const { loan } = await db.transaction((tx) =>
      loansLib.recordLoanReceipt(tx, {
        restaurantId,
        branchId,
        lenderName: "TEST Repayment Lender",
        principalInPaisa: 100_000_00,
        startDate: "2026-01-01",
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    const { loan: afterFirst, voucher } = await db.transaction((tx) =>
      loansLib.recordLoanRepayment(tx, {
        restaurantId,
        branchId,
        loanId: loan.id,
        paymentDate: "2026-02-01",
        principalInPaisa: 8_000_00,
        interestInPaisa: 1_000_00,
        paymentMethod: "cash",
        createdByUserId: userId,
      }),
    );

    expect(afterFirst.outstandingPrincipalInPaisa).toBe(92_000_00);
    expect(afterFirst.status).toBe("active");

    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    const totalDebit = lines.reduce((sum, l) => sum + l.debitInPaisa, 0);
    const totalCredit = lines.reduce((sum, l) => sum + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalCredit).toBe(9_000_00);

    const loanLine = lines.find((l) => l.accountId === loan.chartOfAccountsId)!;
    expect(loanLine.debitInPaisa).toBe(8_000_00);
    const interestLine = lines.find((l) => l.accountId === interestExpenseAccountId)!;
    expect(interestLine.debitInPaisa).toBe(1_000_00);
    const cashLine = lines.find((l) => l.accountId === cashAccountId)!;
    expect(cashLine.creditInPaisa).toBe(9_000_00);

    const payments = await db.transaction((tx) => loansLib.listLoanPayments(tx, { restaurantId, loanId: loan.id }));
    expect(payments.length).toBe(1);
    expect(payments[0].principalInPaisa).toBe(8_000_00);
    expect(payments[0].interestInPaisa).toBe(1_000_00);
  });

  it("rejects a repayment whose principal exceeds the loan's outstanding balance", async () => {
    const { loan } = await db.transaction((tx) =>
      loansLib.recordLoanReceipt(tx, {
        restaurantId,
        branchId,
        lenderName: "TEST Overpay Lender",
        principalInPaisa: 10_000_00,
        startDate: "2026-01-01",
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    await expect(
      db.transaction((tx) =>
        loansLib.recordLoanRepayment(tx, {
          restaurantId,
          branchId,
          loanId: loan.id,
          paymentDate: "2026-02-01",
          principalInPaisa: 20_000_00,
          interestInPaisa: 0,
          paymentMethod: "cash",
          createdByUserId: userId,
        }),
      ),
    ).rejects.toThrow(/can't exceed/i);
  });

  it("auto-closes a loan when a repayment brings the outstanding balance to exactly zero, and rejects a repayment on an already-closed loan", async () => {
    const { loan } = await db.transaction((tx) =>
      loansLib.recordLoanReceipt(tx, {
        restaurantId,
        branchId,
        lenderName: "TEST Final Payment Lender",
        principalInPaisa: 15_000_00,
        startDate: "2026-01-01",
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    const { loan: closed } = await db.transaction((tx) =>
      loansLib.recordLoanRepayment(tx, {
        restaurantId,
        branchId,
        loanId: loan.id,
        paymentDate: "2026-02-01",
        principalInPaisa: 15_000_00,
        interestInPaisa: 0,
        paymentMethod: "cash",
        createdByUserId: userId,
      }),
    );
    expect(closed.outstandingPrincipalInPaisa).toBe(0);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();

    await expect(
      db.transaction((tx) =>
        loansLib.recordLoanRepayment(tx, {
          restaurantId,
          branchId,
          loanId: loan.id,
          paymentDate: "2026-03-01",
          principalInPaisa: 0,
          interestInPaisa: 500_00,
          paymentMethod: "cash",
          createdByUserId: userId,
        }),
      ),
    ).rejects.toThrow(/already closed/i);
  });

  it("recordLoanRepayment omits the loan-payable line entirely for an interest-only payment", async () => {
    const { loan } = await db.transaction((tx) =>
      loansLib.recordLoanReceipt(tx, {
        restaurantId,
        branchId,
        lenderName: "TEST Interest-Only Lender",
        principalInPaisa: 50_000_00,
        startDate: "2026-01-01",
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    const { loan: afterPayment, voucher } = await db.transaction((tx) =>
      loansLib.recordLoanRepayment(tx, {
        restaurantId,
        branchId,
        loanId: loan.id,
        paymentDate: "2026-02-01",
        principalInPaisa: 0,
        interestInPaisa: 500_00,
        paymentMethod: "cash",
        createdByUserId: userId,
      }),
    );
    expect(afterPayment.outstandingPrincipalInPaisa).toBe(50_000_00);

    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    expect(lines.length).toBe(2);
    expect(lines.find((l) => l.accountId === loan.chartOfAccountsId)).toBeUndefined();
  });
});
