/**
 * Integration tests for the Phase 1 double-entry accounting foundation —
 * src/lib/accounting/post-voucher.ts and chart-of-accounts.ts. See
 * ACCOUNTING_MODULE_PLAN.md / ACCOUNTING_POLICY_AND_POSTING_MATRIX.md.
 * Same conventions as combined-billing.test.ts (plain DB fixtures, no RBAC
 * mocking — that's covered by the RBAC test suite separately).
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — postVoucher (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let mappingKeys: typeof import("@/lib/accounting/account-mapping-keys");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let cashAccountId: string;
  let salesAccountId: string;
  let inactiveAccountId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    mappingKeys = await import("@/lib/accounting/account-mapping-keys");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-accounting-${suffix}`, name: "TEST Accounting Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant", phone: `973${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    const [cash] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, "1000")));
    cashAccountId = cash.id;
    const [sales] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, "4000")));
    salesAccountId = sales.id;

    const [inactive] = await db
      .insert(schema.chartOfAccounts)
      .values({
        restaurantId,
        code: "9999",
        name: "TEST Inactive Account",
        type: "expense",
        normalBalance: "debit",
        isActive: false,
      })
      .returning({ id: schema.chartOfAccounts.id });
    inactiveAccountId = inactive.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("seeds the default chart of accounts and account_mappings idempotently", async () => {
    const accounts = await db
      .select()
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.restaurantId, restaurantId));
    // 27 seeded (Phase 4, Slice 4d added "1040 — Bank / Digital Payments";
    // Slice 4f added "1045 — Bank Account"; Phase 5, Slice 5b added "1050 —
    // Bank Accounts", the grouping parent for real bank accounts; Slice 5d
    // added "4920 — Gain/Loss on Disposal of Fixed Assets" and "5150 —
    // Depreciation Expense"; Slice 5e added "5160 — Interest Expense") + the
    // 1 inactive test fixture inserted directly above.
    expect(accounts.length).toBe(29);
    expect(accounts.every((a) => a.code !== "9999" || !a.isActive)).toBe(true);

    const mappings = await db
      .select()
      .from(schema.accountMappings)
      .where(eq(schema.accountMappings.restaurantId, restaurantId));
    const byKey = new Map(mappings.map((m) => [m.mappingKey, m.accountId]));
    expect(byKey.get(mappingKeys.MAPPING_KEYS.PAYMENT_METHOD_CASH)).toBe(cashAccountId);
    expect(byKey.get(mappingKeys.MAPPING_KEYS.SALES_REVENUE)).toBe(salesAccountId);

    // Re-running is a no-op, not a duplicate/error.
    const second = await db.transaction((tx) =>
      chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }),
    );
    expect(second.accountsCreated).toBe(0);
    expect(second.mappingsCreated).toBe(0);
  });

  it("posts a balanced voucher and assigns a type-prefixed sequential number", async () => {
    const result = await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "journal",
        createdByUserId: userId,
        narration: "TEST manual sale entry",
        lines: [
          { accountId: cashAccountId, debitInPaisa: 100_00 },
          { accountId: salesAccountId, creditInPaisa: 100_00 },
        ],
      }),
    );

    expect(result.replayed).toBe(false);
    expect(result.voucher.status).toBe("posted");
    expect(result.voucher.voucherNumber).toMatch(/^JV-\d{6}$/);
    expect(result.lines).toHaveLength(2);

    const second = await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "journal",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 50_00 },
          { accountId: salesAccountId, creditInPaisa: 50_00 },
        ],
      }),
    );
    // Sequential per restaurant+type, never reused.
    const firstNum = parseInt(result.voucher.voucherNumber.split("-")[1], 10);
    const secondNum = parseInt(second.voucher.voucherNumber.split("-")[1], 10);
    expect(secondNum).toBe(firstNum + 1);
  });

  it("rejects an unbalanced voucher without inserting anything", async () => {
    await expect(
      db.transaction((tx) =>
        postVoucherLib.postVoucher(tx, {
          restaurantId,
          branchId,
          voucherType: "journal",
          createdByUserId: userId,
          lines: [
            { accountId: cashAccountId, debitInPaisa: 100_00 },
            { accountId: salesAccountId, creditInPaisa: 90_00 },
          ],
        }),
      ),
    ).rejects.toThrow(/not balanced/i);
  });

  it("rejects a line that is debited and credited at once, or neither", async () => {
    await expect(
      db.transaction((tx) =>
        postVoucherLib.postVoucher(tx, {
          restaurantId,
          branchId,
          voucherType: "journal",
          createdByUserId: userId,
          lines: [
            { accountId: cashAccountId, debitInPaisa: 100_00, creditInPaisa: 100_00 },
            { accountId: salesAccountId, creditInPaisa: 100_00 },
          ],
        }),
      ),
    ).rejects.toThrow(/exactly one of debit\/credit/i);
  });

  it("rejects posting to an inactive account", async () => {
    await expect(
      db.transaction((tx) =>
        postVoucherLib.postVoucher(tx, {
          restaurantId,
          branchId,
          voucherType: "journal",
          createdByUserId: userId,
          lines: [
            { accountId: inactiveAccountId, debitInPaisa: 100_00 },
            { accountId: salesAccountId, creditInPaisa: 100_00 },
          ],
        }),
      ),
    ).rejects.toThrow(/inactive/i);
  });

  it("rejects a non-opening_balance voucher that posts to Opening Balance Equity (3200), per Part 1.2's write-guard", async () => {
    const [openingBalanceEquity] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, "3200")));

    await expect(
      db.transaction((tx) =>
        postVoucherLib.postVoucher(tx, {
          restaurantId,
          branchId,
          voucherType: "journal",
          createdByUserId: userId,
          lines: [
            { accountId: cashAccountId, debitInPaisa: 100_00 },
            { accountId: openingBalanceEquity.id, creditInPaisa: 100_00 },
          ],
        }),
      ),
    ).rejects.toThrow(/opening balance equity.*one-time opening balance voucher/i);

    // The guard is scoped to voucherType — an actual "opening_balance"
    // voucher (the one-time cutover route's own type) still posts fine.
    const result = await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "opening_balance",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 100_00 },
          { accountId: openingBalanceEquity.id, creditInPaisa: 100_00 },
        ],
      }),
    );
    expect(result.voucher.voucherType).toBe("opening_balance");
  });

  it("is idempotent on the source/postingEvent key — a replay returns the original, never double-posts", async () => {
    const first = await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        createdByUserId: userId,
        sourceType: "order_completion",
        sourceId: "11111111-1111-1111-1111-111111111111",
        postingEvent: "sale",
        lines: [
          { accountId: cashAccountId, debitInPaisa: 200_00 },
          { accountId: salesAccountId, creditInPaisa: 200_00 },
        ],
      }),
    );

    const replay = await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        createdByUserId: userId,
        sourceType: "order_completion",
        sourceId: "11111111-1111-1111-1111-111111111111",
        postingEvent: "sale",
        // Deliberately different amount — a true replay should return the
        // ORIGINAL voucher untouched, never re-derive from this call's
        // (differing) input.
        lines: [
          { accountId: cashAccountId, debitInPaisa: 999_00 },
          { accountId: salesAccountId, creditInPaisa: 999_00 },
        ],
      }),
    );

    expect(replay.replayed).toBe(true);
    expect(replay.voucher.id).toBe(first.voucher.id);
    expect(replay.voucher.voucherNumber).toBe(first.voucher.voucherNumber);

    const allSales = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceId, "11111111-1111-1111-1111-111111111111"),
        ),
      );
    expect(allSales).toHaveLength(1);
  });

  it("reverseVoucher posts an equal-and-opposite voucher and marks the original reversed", async () => {
    const original = await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "journal",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 75_00 },
          { accountId: salesAccountId, creditInPaisa: 75_00 },
        ],
      }),
    );

    const reversal = await db.transaction((tx) =>
      postVoucherLib.reverseVoucher(tx, {
        restaurantId,
        voucherId: original.voucher.id,
        reason: "TEST entered in error",
        reversedByUserId: userId,
      }),
    );

    expect(reversal.voucher.id).not.toBe(original.voucher.id);
    const reversalLines = reversal.lines.sort((a, b) => a.accountId.localeCompare(b.accountId));
    // Same accounts, sides swapped.
    for (const line of reversalLines) {
      if (line.accountId === cashAccountId) {
        expect(line.creditInPaisa).toBe(75_00);
        expect(line.debitInPaisa).toBe(0);
      }
      if (line.accountId === salesAccountId) {
        expect(line.debitInPaisa).toBe(75_00);
        expect(line.creditInPaisa).toBe(0);
      }
    }

    const [originalRow] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(eq(schema.accountingVouchers.id, original.voucher.id));
    expect(originalRow.status).toBe("reversed");

    const [reversalRow] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(eq(schema.accountingVouchers.id, reversal.voucher.id));
    expect(reversalRow.reversalOfVoucherId).toBe(original.voucher.id);

    await expect(
      db.transaction((tx) =>
        postVoucherLib.reverseVoucher(tx, {
          restaurantId,
          voucherId: original.voucher.id,
          reason: "TEST double reversal attempt",
          reversedByUserId: userId,
        }),
      ),
    ).rejects.toThrow(/already been reversed/i);
  });

  it("rejects posting into a closed accounting period unless explicitly allowed", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [period] = await db
      .insert(schema.accountingPeriods)
      .values({
        restaurantId,
        periodStart: today,
        periodEnd: today,
        status: "closed",
      })
      .returning();

    await expect(
      db.transaction((tx) =>
        postVoucherLib.postVoucher(tx, {
          restaurantId,
          branchId,
          voucherType: "journal",
          voucherDate: today,
          createdByUserId: userId,
          lines: [
            { accountId: cashAccountId, debitInPaisa: 10_00 },
            { accountId: salesAccountId, creditInPaisa: 10_00 },
          ],
        }),
      ),
    ).rejects.toThrow(/closed/i);

    const allowed = await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "journal",
        voucherDate: today,
        createdByUserId: userId,
        allowClosedPeriod: true,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 10_00 },
          { accountId: salesAccountId, creditInPaisa: 10_00 },
        ],
      }),
    );
    expect(allowed.replayed).toBe(false);

    await db.delete(schema.accountingPeriods).where(eq(schema.accountingPeriods.id, period.id));
  });
});
