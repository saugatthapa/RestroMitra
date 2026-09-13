/**
 * Integration tests for src/lib/accounting/balances.ts — the per-account
 * balance and running-ledger math behind Phase 2's Overview, Chart of
 * Accounts, and Ledger Accounts screens. Verifies the plan's own Phase 2
 * exit criteria: a posted voucher shows up with a correct running balance
 * on both accounts it touches.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — balances (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let balancesLib: typeof import("@/lib/accounting/balances");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let cashAccountId: string; // debit-normal
  let capitalAccountId: string; // credit-normal

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    balancesLib = await import("@/lib/accounting/balances");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-balances-${suffix}`, name: "TEST Balances Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant 2", phone: `974${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [cash] = await db
      .insert(schema.chartOfAccounts)
      .values({ restaurantId, code: "T1000", name: "TEST Cash", type: "asset", normalBalance: "debit" })
      .returning({ id: schema.chartOfAccounts.id });
    cashAccountId = cash.id;

    const [capital] = await db
      .insert(schema.chartOfAccounts)
      .values({ restaurantId, code: "T3000", name: "TEST Owner Capital", type: "equity", normalBalance: "credit" })
      .returning({ id: schema.chartOfAccounts.id });
    capitalAccountId = capital.id;

    // Two postings: an owner investment, then a partial withdrawal —
    // exercises both a credit and a debit against the SAME credit-normal
    // account, and confirms the debit-normal cash account's running
    // balance moves the opposite direction each time.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "journal",
        voucherDate: "2025-01-01",
        createdByUserId: userId,
        narration: "TEST owner investment",
        lines: [
          { accountId: cashAccountId, debitInPaisa: 500_00 },
          { accountId: capitalAccountId, creditInPaisa: 500_00 },
        ],
      }),
    );
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "journal",
        voucherDate: "2025-01-05",
        createdByUserId: userId,
        narration: "TEST partial withdrawal",
        lines: [
          { accountId: capitalAccountId, debitInPaisa: 200_00 },
          { accountId: cashAccountId, creditInPaisa: 200_00 },
        ],
      }),
    );
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("getAccountBalances computes the correct signed balance per normalBalance", async () => {
    const { accounts, totalsByType } = await balancesLib.getAccountBalances({ restaurantId });

    const cash = accounts.find((a) => a.accountId === cashAccountId)!;
    const capital = accounts.find((a) => a.accountId === capitalAccountId)!;

    // Cash (debit-normal): +500 debit, -200 (i.e. a 200 credit) = 300.
    expect(cash.balanceInPaisa).toBe(300_00);
    // Capital (credit-normal): +500 credit, -200 (a 200 debit) = 300.
    expect(capital.balanceInPaisa).toBe(300_00);

    expect(totalsByType.asset).toBeGreaterThanOrEqual(300_00);
    expect(totalsByType.equity).toBeGreaterThanOrEqual(300_00);
  });

  it("getAccountLedger returns lines in date order with a correct running balance", async () => {
    const { account, lines } = await balancesLib.getAccountLedger({
      restaurantId,
      accountId: cashAccountId,
    });

    expect(account?.balanceInPaisa).toBe(300_00);
    expect(lines).toHaveLength(2);
    expect(lines[0].voucherDate).toBe("2025-01-01");
    expect(lines[0].debitInPaisa).toBe(500_00);
    expect(lines[0].runningBalanceInPaisa).toBe(500_00);
    expect(lines[1].voucherDate).toBe("2025-01-05");
    expect(lines[1].creditInPaisa).toBe(200_00);
    expect(lines[1].runningBalanceInPaisa).toBe(300_00);
  });

  it("getAccountLedger returns null for an account belonging to a different restaurant", async () => {
    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-other-${Math.random().toString(36).slice(2, 8)}`, name: "TEST Other" })
      .returning({ id: schema.restaurants.id });

    const { account } = await balancesLib.getAccountLedger({
      restaurantId: otherRestaurant.id,
      accountId: cashAccountId,
    });
    expect(account).toBeNull();

    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurant.id));
  });

  it("deactivating an account is reflected by the Chart of Accounts route logic (isActive on the row)", async () => {
    await db
      .update(schema.chartOfAccounts)
      .set({ isActive: false })
      .where(and(eq(schema.chartOfAccounts.id, capitalAccountId), eq(schema.chartOfAccounts.restaurantId, restaurantId)));

    const { accounts } = await balancesLib.getAccountBalances({ restaurantId });
    const capital = accounts.find((a) => a.accountId === capitalAccountId)!;
    expect(capital.isActive).toBe(false);
    // Balance math is unaffected by active/inactive — history stays intact.
    expect(capital.balanceInPaisa).toBe(300_00);
  });
});
