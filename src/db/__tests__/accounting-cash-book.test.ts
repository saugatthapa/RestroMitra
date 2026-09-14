/**
 * Integration tests for src/lib/accounting/cash-book.ts — Phase 7, Slice
 * 7a's Cash Book / Bank Book report: one account, one date range, an
 * opening balance carried from before `fromDate`, a running balance
 * through the period, and a closing balance. Skipped (not failed) when
 * DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — cash book / bank book report (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let bankAccountsLib: typeof import("@/lib/accounting/bank-accounts");
  let cashBookLib: typeof import("@/lib/accounting/cash-book");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let cashAccountId: string;
  let salesRevenueAccountId: string;
  let cogsAccountId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    bankAccountsLib = await import("@/lib/accounting/bank-accounts");
    cashBookLib = await import("@/lib/accounting/cash-book");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cash-book-${suffix}`, name: "TEST Cash Book Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Cash Book Accountant", phone: `977${suffix}`, passwordHash: "x" })
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
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("carries an opening balance from before fromDate, then a running balance through the period, ending at the closing balance", async () => {
    // Before the report window: +40,000 (April).
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-04-20",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 40_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 40_000_00 },
        ],
      }),
    );

    // Inside the window (May): +15,000 on the 5th, -6,000 on the 20th.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-05-05",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 15_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 15_000_00 },
        ],
      }),
    );
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "expense",
        voucherDate: "2026-05-20",
        createdByUserId: userId,
        lines: [
          { accountId: cogsAccountId, debitInPaisa: 6_000_00 },
          { accountId: cashAccountId, creditInPaisa: 6_000_00 },
        ],
      }),
    );

    // After the window (June): should not affect this report at all.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-06-02",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 9_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 9_000_00 },
        ],
      }),
    );

    const report = await cashBookLib.getCashBookReport({
      restaurantId,
      accountId: cashAccountId,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
    });

    expect(report).not.toBeNull();
    expect(report!.openingBalanceInPaisa).toBe(40_000_00);
    expect(report!.lines).toHaveLength(2);
    expect(report!.lines[0].runningBalanceInPaisa).toBe(55_000_00); // 40,000 + 15,000
    expect(report!.lines[1].runningBalanceInPaisa).toBe(49_000_00); // 55,000 - 6,000
    expect(report!.closingBalanceInPaisa).toBe(49_000_00);
    expect(report!.totalDebitInPaisa).toBe(15_000_00);
    expect(report!.totalCreditInPaisa).toBe(6_000_00);
    expect(report!.account.code).toBe("1000");
  });

  it("returns an empty period cleanly when nothing posted in range, with opening = closing", async () => {
    const report = await cashBookLib.getCashBookReport({
      restaurantId,
      accountId: cashAccountId,
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    expect(report).not.toBeNull();
    expect(report!.lines).toHaveLength(0);
    expect(report!.openingBalanceInPaisa).toBe(0);
    expect(report!.closingBalanceInPaisa).toBe(0);
  });

  it("returns null for an account that doesn't belong to this restaurant", async () => {
    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cash-book-other-${Math.random().toString(36).slice(2, 8)}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId: otherRestaurant.id }));
    const [otherCash] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.restaurantId, otherRestaurant.id));

    const report = await cashBookLib.getCashBookReport({
      restaurantId,
      accountId: otherCash.id,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
    });
    expect(report).toBeNull();

    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurant.id));
  });

  it("listCashAndBankAccounts includes seeded cash-like accounts and any real bank account, but excludes clearing/AR/AP accounts", async () => {
    const before = await cashBookLib.listCashAndBankAccounts(restaurantId);
    const beforeCodes = before.map((a) => a.code);
    expect(beforeCodes).toContain("1000"); // Cash on Hand
    expect(beforeCodes).not.toContain("1010"); // a clearing account
    expect(beforeCodes).not.toContain("1100"); // Accounts Receivable (not a cash/bank account)

    await db.transaction((tx) =>
      bankAccountsLib.provisionBankAccount(tx, {
        restaurantId,
        bankName: "TEST NIC Asia",
        createdByUserId: userId,
      }),
    );

    const after = await cashBookLib.listCashAndBankAccounts(restaurantId);
    expect(after.some((a) => a.name === "TEST NIC Asia")).toBe(true);
  });
});
