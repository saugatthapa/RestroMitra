/**
 * Integration tests for Phase 4, Slice 4d —
 * src/lib/accounting/integrations/expenses.ts (expense payment posting,
 * expense-category auto-provisioning, and the void/un-void reversal chain).
 * See ACCOUNTING_PHASE_4_PLAN.md and
 * ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §5.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, gte } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — Slice 4d: expenses (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let expensesLib: typeof import("@/lib/accounting/integrations/expenses");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let accountIdByCode: Map<string, string>;

  async function findAccountByCode(code: string) {
    const [row] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, code)));
    return row.id;
  }

  async function makeCategory(name: string) {
    const [category] = await db
      .insert(schema.expenseCategories)
      .values({ restaurantId, name })
      .returning();
    return category;
  }

  async function makePaidExpense(params: { categoryId: string; amountInPaisa: number; paymentMethod: string }) {
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        restaurantId,
        branchId,
        categoryId: params.categoryId,
        amountInPaisa: params.amountInPaisa,
        description: "TEST expense",
        status: "paid",
        paymentMethod: params.paymentMethod as (typeof schema.expensePaymentMethodEnum.enumValues)[number],
        paidAt: new Date(),
      })
      .returning();
    return expense;
  }

  async function voucherLinesFor(sourceId: string, postingEvent: string) {
    const [voucher] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceType, "expense_payment"),
          eq(schema.accountingVouchers.sourceId, sourceId),
          eq(schema.accountingVouchers.postingEvent, postingEvent),
        ),
      );
    if (!voucher) return null;
    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    return { voucher, lines };
  }

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    expensesLib = await import("@/lib/accounting/integrations/expenses");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-expenses-${suffix}`, name: "TEST Expenses Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant 7", phone: `977${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    accountIdByCode = new Map();
    for (const code of ["1000", "1030", "1040"]) {
      accountIdByCode.set(code, await findAccountByCode(code));
    }
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("a cash expense posts Dr [category account] / Cr Cash on Hand, auto-provisioning the category's account", async () => {
    const category = await makeCategory("TEST Rent");
    const expense = await makePaidExpense({ categoryId: category.id, amountInPaisa: 5000_00, paymentMethod: "cash" });

    const result = await db.transaction((tx) =>
      expensesLib.postExpenseVoucher(tx, {
        restaurantId,
        branchId,
        expenseId: expense.id,
        categoryId: category.id,
        categoryName: category.name,
        amountInPaisa: expense.amountInPaisa,
        paymentMethod: "cash",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    expect(result.autoProvisionedAccount).not.toBeNull();
    expect(result.autoProvisionedAccount!.name).toBe("TEST Rent");
    expect(Number(result.autoProvisionedAccount!.code)).toBeGreaterThanOrEqual(5200);

    const posted = await voucherLinesFor(expense.id, "paid");
    expect(posted).not.toBeNull();
    const cashId = accountIdByCode.get("1000")!;
    expect(posted!.lines.find((l) => l.accountId === result.autoProvisionedAccount!.id)?.debitInPaisa).toBe(5000_00);
    expect(posted!.lines.find((l) => l.accountId === cashId)?.creditInPaisa).toBe(5000_00);

    // A second expense in the SAME category reuses the account — no second
    // auto-provisioning.
    const expense2 = await makePaidExpense({ categoryId: category.id, amountInPaisa: 1000_00, paymentMethod: "cash" });
    const result2 = await db.transaction((tx) =>
      expensesLib.postExpenseVoucher(tx, {
        restaurantId,
        branchId,
        expenseId: expense2.id,
        categoryId: category.id,
        categoryName: category.name,
        amountInPaisa: expense2.amountInPaisa,
        paymentMethod: "cash",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    expect(result2.autoProvisionedAccount).toBeNull();
    const posted2 = await voucherLinesFor(expense2.id, "paid");
    expect(posted2!.lines.find((l) => l.accountId === result.autoProvisionedAccount!.id)?.debitInPaisa).toBe(1000_00);
  });

  it("bank_transfer, eSewa, and Khalti expenses all share the Bank / Digital Payments account", async () => {
    const category = await makeCategory("TEST Utilities");
    const bankId = accountIdByCode.get("1040")!;

    for (const method of ["bank_transfer", "esewa", "khalti", "mobile_banking"] as const) {
      const expense = await makePaidExpense({ categoryId: category.id, amountInPaisa: 200_00, paymentMethod: method });
      await db.transaction((tx) =>
        expensesLib.postExpenseVoucher(tx, {
          restaurantId,
          branchId,
          expenseId: expense.id,
          categoryId: category.id,
          categoryName: category.name,
          amountInPaisa: expense.amountInPaisa,
          paymentMethod: method,
          timezone: "Asia/Kathmandu",
          createdByUserId: userId,
        }),
      );
      const posted = await voucherLinesFor(expense.id, "paid");
      expect(posted!.lines.find((l) => l.accountId === bankId)?.creditInPaisa).toBe(200_00);
    }
  });

  it("an 'other' expense posts against Other Clearing", async () => {
    const category = await makeCategory("TEST Miscellaneous");
    const expense = await makePaidExpense({ categoryId: category.id, amountInPaisa: 300_00, paymentMethod: "other" });
    await db.transaction((tx) =>
      expensesLib.postExpenseVoucher(tx, {
        restaurantId,
        branchId,
        expenseId: expense.id,
        categoryId: category.id,
        categoryName: category.name,
        amountInPaisa: expense.amountInPaisa,
        paymentMethod: "other",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    const otherId = accountIdByCode.get("1030")!;
    const posted = await voucherLinesFor(expense.id, "paid");
    expect(posted!.lines.find((l) => l.accountId === otherId)?.creditInPaisa).toBe(300_00);
  });

  it("voiding then un-voiding a paid expense nets back to the original posting, without double-counting", async () => {
    const category = await makeCategory("TEST Supplies");
    const expense = await makePaidExpense({ categoryId: category.id, amountInPaisa: 750_00, paymentMethod: "cash" });
    await db.transaction((tx) =>
      expensesLib.postExpenseVoucher(tx, {
        restaurantId,
        branchId,
        expenseId: expense.id,
        categoryId: category.id,
        categoryName: category.name,
        amountInPaisa: expense.amountInPaisa,
        paymentMethod: "cash",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    const original = await voucherLinesFor(expense.id, "paid");
    const categoryAccountId = original!.lines.find((l) => l.debitInPaisa > 0)!.accountId;
    const cashId = accountIdByCode.get("1000")!;

    // Void.
    await db.transaction((tx) =>
      expensesLib.reverseOrRestoreExpenseVoucher(tx, {
        restaurantId,
        expenseId: expense.id,
        reason: "TEST void",
        reversedByUserId: userId,
        timezone: "Asia/Kathmandu",
      }),
    );
    const afterVoid = await voucherLinesFor(expense.id, "paid");
    expect(afterVoid!.voucher.status).toBe("reversed");

    async function linesOfReversalOf(voucherId: string) {
      const [reversal] = await db
        .select()
        .from(schema.accountingVouchers)
        .where(eq(schema.accountingVouchers.reversalOfVoucherId, voucherId));
      const lines = await db
        .select()
        .from(schema.accountingVoucherLines)
        .where(eq(schema.accountingVoucherLines.voucherId, reversal.id));
      return { voucher: reversal, lines };
    }

    type VoucherLine = Awaited<ReturnType<typeof linesOfReversalOf>>["lines"][number];
    const netFor = (accountId: string, lineSets: VoucherLine[][]) =>
      lineSets
        .flat()
        .filter((l) => l.accountId === accountId)
        .reduce((s, l) => s + l.debitInPaisa - l.creditInPaisa, 0);

    // reversal1 (the void) has every line swapped relative to the original —
    // net across the two should already be zero.
    const reversal1 = await linesOfReversalOf(original!.voucher.id);
    expect(netFor(categoryAccountId, [original!.lines, reversal1.lines])).toBe(0);
    expect(netFor(cashId, [original!.lines, reversal1.lines])).toBe(0);

    // Un-void — reverses reversal1 itself, restoring the original direction.
    await db.transaction((tx) =>
      expensesLib.reverseOrRestoreExpenseVoucher(tx, {
        restaurantId,
        expenseId: expense.id,
        reason: "TEST un-void",
        reversedByUserId: userId,
        timezone: "Asia/Kathmandu",
      }),
    );
    const reversal2 = await linesOfReversalOf(reversal1.voucher.id);

    // Net across all three vouchers reproduces exactly the original posting
    // — the expense reads as paid again, without the till having "received"
    // or "paid out" the amount more than the one real time it happened.
    expect(netFor(categoryAccountId, [original!.lines, reversal1.lines, reversal2.lines])).toBe(750_00);
    expect(netFor(cashId, [original!.lines, reversal1.lines, reversal2.lines])).toBe(-750_00);
  });

  it("is idempotent — replaying the same expense posting posts only one voucher", async () => {
    const category = await makeCategory("TEST Idempotency");
    const expense = await makePaidExpense({ categoryId: category.id, amountInPaisa: 100_00, paymentMethod: "cash" });
    const post = () =>
      db.transaction((tx) =>
        expensesLib.postExpenseVoucher(tx, {
          restaurantId,
          branchId,
          expenseId: expense.id,
          categoryId: category.id,
          categoryName: category.name,
          amountInPaisa: expense.amountInPaisa,
          paymentMethod: "cash",
          timezone: "Asia/Kathmandu",
          createdByUserId: userId,
        }),
      );
    await post();
    await post();

    const allVouchers = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceId, expense.id),
          eq(schema.accountingVouchers.postingEvent, "paid"),
        ),
      );
    expect(allVouchers).toHaveLength(1);
  });

  it("auto-provisioned accounts land in the reserved 5200+ block, never colliding with the fixed seed", async () => {
    const rows = await db
      .select({ code: schema.chartOfAccounts.code })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), gte(schema.chartOfAccounts.code, "5200")));
    // At least the categories created by the earlier tests in this file.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.code)).toBeGreaterThanOrEqual(5200);
    }
  });
});
