/**
 * Integration tests for src/lib/accounting/health-check.ts — Phase 7,
 * Slice 7e's Accounting Health validator: read-only diagnostics over an
 * existing restaurant's books.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — health check (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let healthLib: typeof import("@/lib/accounting/health-check");

  const createdRestaurantIds: string[] = [];

  async function createFixture() {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    healthLib = await import("@/lib/accounting/health-check");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-health-${suffix}`, name: "TEST Health Restaurant" })
      .returning({ id: schema.restaurants.id });
    createdRestaurantIds.push(restaurant.id);

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurant.id, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Health Accountant", phone: `976${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });

    const chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId: restaurant.id }));
    const seeded = await db
      .select({ id: schema.chartOfAccounts.id, code: schema.chartOfAccounts.code })
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.restaurantId, restaurant.id));
    const byCode = new Map(seeded.map((a) => [a.code, a.id]));

    return {
      restaurantId: restaurant.id,
      branchId: branch.id,
      userId: user.id,
      cashAccountId: byCode.get("1000")!,
      arAccountId: byCode.get("1100")!,
      salesRevenueAccountId: byCode.get("4000")!,
    };
  }

  afterEach(async () => {
    for (const id of createdRestaurantIds.splice(0)) {
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, id));
    }
  });

  it("reports a clean, healthy set of books as all-pass", async () => {
    const fx = await createFixture();
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId: fx.restaurantId,
        branchId: fx.branchId,
        voucherType: "sales",
        voucherDate: "2026-05-05",
        narration: "TEST clean sale",
        createdByUserId: fx.userId,
        lines: [
          { accountId: fx.cashAccountId, debitInPaisa: 10_000_00 },
          { accountId: fx.salesRevenueAccountId, creditInPaisa: 10_000_00 },
        ],
      }),
    );

    const report = await healthLib.getAccountingHealthReport({ restaurantId: fx.restaurantId, timezone: "Asia/Kathmandu" });

    expect(report.overallSeverity).toBe("pass");
    for (const check of report.checks) {
      expect(check.severity).toBe("pass");
      expect(check.issues).toEqual([]);
    }
  });

  it("flags a voucher whose lines don't balance (bypassing postVoucher directly)", async () => {
    const fx = await createFixture();

    // Deliberately bypasses postVoucher() — the only way to construct an
    // unbalanced voucher, since postVoucher() itself refuses to (this is
    // exactly the future-code-path-bypass scenario this check exists for).
    const [voucher] = await db
      .insert(schema.accountingVouchers)
      .values({
        restaurantId: fx.restaurantId,
        branchId: fx.branchId,
        voucherType: "journal",
        voucherNumber: "TEST-UNBALANCED-0001",
        voucherDate: "2026-05-06",
        narration: "TEST deliberately unbalanced voucher",
      })
      .returning({ id: schema.accountingVouchers.id, voucherNumber: schema.accountingVouchers.voucherNumber });
    await db.insert(schema.accountingVoucherLines).values([
      { voucherId: voucher.id, accountId: fx.cashAccountId, debitInPaisa: 1_000_00, creditInPaisa: 0 },
      { voucherId: voucher.id, accountId: fx.salesRevenueAccountId, debitInPaisa: 0, creditInPaisa: 500_00 },
    ]);

    const report = await healthLib.getAccountingHealthReport({ restaurantId: fx.restaurantId, timezone: "Asia/Kathmandu" });

    const voucherCheck = report.checks.find((c) => c.id === "voucherBalance")!;
    expect(voucherCheck.severity).toBe("attention");
    expect(voucherCheck.issues).toHaveLength(1);
    expect(voucherCheck.issues[0].message).toContain(voucher.voucherNumber);
    expect(report.overallSeverity).toBe("attention");

    // The independent balance-consistency recomputation should still agree
    // with itself even though the underlying voucher is unbalanced — both
    // sides read the exact same (imbalanced) data, so this is a genuinely
    // separate concern from voucherBalance above.
    const balanceCheck = report.checks.find((c) => c.id === "balanceConsistency")!;
    expect(balanceCheck.severity).toBe("pass");
  });

  it("flags a deactivated account that still has posting history as info, not an error", async () => {
    const fx = await createFixture();
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId: fx.restaurantId,
        branchId: fx.branchId,
        voucherType: "sales",
        voucherDate: "2026-05-05",
        narration: "TEST sale before deactivation",
        createdByUserId: fx.userId,
        lines: [
          { accountId: fx.cashAccountId, debitInPaisa: 5_000_00 },
          { accountId: fx.salesRevenueAccountId, creditInPaisa: 5_000_00 },
        ],
      }),
    );
    await db.update(schema.chartOfAccounts).set({ isActive: false }).where(eq(schema.chartOfAccounts.id, fx.salesRevenueAccountId));

    const report = await healthLib.getAccountingHealthReport({ restaurantId: fx.restaurantId, timezone: "Asia/Kathmandu" });

    const check = report.checks.find((c) => c.id === "deactivatedAccountsWithActivity")!;
    expect(check.severity).toBe("info");
    expect(check.issues).toHaveLength(1);
    expect(check.issues[0].message).toContain("4000");
    // "info" alone shouldn't escalate the overall severity to "attention".
    expect(report.overallSeverity).toBe("info");
  });

  it("flags an Accounts Receivable control account posting that isn't tagged with a customer", async () => {
    const fx = await createFixture();
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId: fx.restaurantId, fullName: "TEST Customer", phone: "9800000001" })
      .returning({ id: schema.customers.id });

    // Properly tagged charge — aging and the control account agree on this one.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId: fx.restaurantId,
        branchId: fx.branchId,
        voucherType: "sales",
        voucherDate: "2026-05-05",
        narration: "TEST tagged AR charge",
        createdByUserId: fx.userId,
        lines: [
          { accountId: fx.arAccountId, debitInPaisa: 5_000_00, customerId: customer.id },
          { accountId: fx.salesRevenueAccountId, creditInPaisa: 5_000_00 },
        ],
      }),
    );
    // An AR posting with no customerId tag — invisible to the aging
    // report's own party breakdown, but still moves the control account's
    // ledger balance. This is exactly the gap this check exists to catch.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId: fx.restaurantId,
        branchId: fx.branchId,
        voucherType: "journal",
        voucherDate: "2026-05-06",
        narration: "TEST untagged AR adjustment",
        createdByUserId: fx.userId,
        lines: [
          { accountId: fx.arAccountId, debitInPaisa: 1_000_00 },
          { accountId: fx.salesRevenueAccountId, creditInPaisa: 1_000_00 },
        ],
      }),
    );

    const report = await healthLib.getAccountingHealthReport({ restaurantId: fx.restaurantId, timezone: "Asia/Kathmandu" });

    const check = report.checks.find((c) => c.id === "arApReconciliation")!;
    expect(check.severity).toBe("attention");
    expect(check.issues).toHaveLength(1);
    expect(check.issues[0].message).toContain("Accounts Receivable");
  });

  it("returns a clean reconciliation when every AR/AP line is properly tagged", async () => {
    const fx = await createFixture();
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId: fx.restaurantId, fullName: "TEST Reconciled Customer", phone: "9800000002" })
      .returning({ id: schema.customers.id });
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId: fx.restaurantId,
        branchId: fx.branchId,
        voucherType: "sales",
        voucherDate: "2026-05-05",
        narration: "TEST fully tagged AR charge",
        createdByUserId: fx.userId,
        lines: [
          { accountId: fx.arAccountId, debitInPaisa: 3_000_00, customerId: customer.id },
          { accountId: fx.salesRevenueAccountId, creditInPaisa: 3_000_00 },
        ],
      }),
    );

    const report = await healthLib.getAccountingHealthReport({ restaurantId: fx.restaurantId, timezone: "Asia/Kathmandu" });

    const check = report.checks.find((c) => c.id === "arApReconciliation")!;
    expect(check.severity).toBe("pass");
    expect(check.issues).toEqual([]);
  });
});
