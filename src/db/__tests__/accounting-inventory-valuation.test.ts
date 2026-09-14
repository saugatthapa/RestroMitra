/**
 * Integration tests for src/lib/accounting/inventory-valuation.ts — Phase
 * 7, Slice 7d's Inventory Valuation report: the Inventory account's own
 * ledger balance, with period activity grouped into Purchases / Cost of
 * Goods Sold / Adjustments.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — inventory valuation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let inventoryLib: typeof import("@/lib/accounting/inventory-valuation");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let cashAccountId: string;
  let inventoryAccountId: string;
  let cogsAccountId: string;
  let openingBalanceEquityAccountId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    inventoryLib = await import("@/lib/accounting/inventory-valuation");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-inv-val-${suffix}`, name: "TEST Inventory Valuation Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Inventory Accountant", phone: `979${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));
    const seeded = await db
      .select({ id: schema.chartOfAccounts.id, code: schema.chartOfAccounts.code })
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.restaurantId, restaurantId));
    const byCode = new Map(seeded.map((a) => [a.code, a.id]));
    cashAccountId = byCode.get("1000")!;
    inventoryAccountId = byCode.get("1200")!;
    cogsAccountId = byCode.get("5000")!;
    openingBalanceEquityAccountId = byCode.get("3200")!;

    // Opening balance (April, before the report window) — establishes a
    // non-zero opening valuation for the May report below.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "opening_balance",
        voucherDate: "2026-04-30",
        narration: "TEST opening inventory balance",
        createdByUserId: userId,
        lines: [
          { accountId: inventoryAccountId, debitInPaisa: 50_000_00 },
          { accountId: openingBalanceEquityAccountId, creditInPaisa: 50_000_00 },
        ],
      }),
    );
    // A purchase (May, in range) — increases inventory.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "purchase",
        voucherDate: "2026-05-05",
        narration: "TEST May stock purchase",
        createdByUserId: userId,
        lines: [
          { accountId: inventoryAccountId, debitInPaisa: 20_000_00 },
          { accountId: cashAccountId, creditInPaisa: 20_000_00 },
        ],
      }),
    );
    // A sale's COGS leg (May, in range) — decreases inventory.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-05-10",
        narration: "TEST May sale COGS leg",
        createdByUserId: userId,
        lines: [
          { accountId: cogsAccountId, debitInPaisa: 8_000_00 },
          { accountId: inventoryAccountId, creditInPaisa: 8_000_00 },
        ],
      }),
    );
    // A manual journal adjustment (May, in range) — a stock write-down,
    // neither a purchase nor a sale's COGS leg.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "journal",
        voucherDate: "2026-05-20",
        narration: "TEST May stock write-down adjustment",
        createdByUserId: userId,
        lines: [
          { accountId: cogsAccountId, debitInPaisa: 1_500_00 },
          { accountId: inventoryAccountId, creditInPaisa: 1_500_00 },
        ],
      }),
    );
    // Out of range (June) — proves date filtering works.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "purchase",
        voucherDate: "2026-06-01",
        narration: "TEST June purchase (out of range)",
        createdByUserId: userId,
        lines: [
          { accountId: inventoryAccountId, debitInPaisa: 9_000_00 },
          { accountId: cashAccountId, creditInPaisa: 9_000_00 },
        ],
      }),
    );
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("returns opening/closing valuation and categorized movement for the period", async () => {
    const report = await inventoryLib.getInventoryValuationReport({
      restaurantId,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
    });

    expect(report).not.toBeNull();
    expect(report!.accountCode).toBe("1200");
    expect(report!.openingValuationInPaisa).toBe(50_000_00);
    expect(report!.purchasesInPaisa).toBe(20_000_00);
    expect(report!.costOfGoodsSoldInPaisa).toBe(-8_000_00);
    expect(report!.adjustmentsInPaisa).toBe(-1_500_00);
    expect(report!.closingValuationInPaisa).toBe(50_000_00 + 20_000_00 - 8_000_00 - 1_500_00);
    // Only the three in-range lines — the June purchase is excluded.
    expect(report!.lines).toHaveLength(3);
  });

  it("excludes activity outside the date range", async () => {
    const report = await inventoryLib.getInventoryValuationReport({
      restaurantId,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
    });
    expect(report!.lines.every((l) => l.voucherDate >= "2026-05-01" && l.voucherDate <= "2026-05-31")).toBe(true);
  });

  it("returns a clean zeroed report (not an error) for a period with no activity", async () => {
    const report = await inventoryLib.getInventoryValuationReport({
      restaurantId,
      fromDate: "2020-01-01",
      toDate: "2020-01-31",
    });
    expect(report).not.toBeNull();
    expect(report!.lines).toEqual([]);
    expect(report!.purchasesInPaisa).toBe(0);
    expect(report!.costOfGoodsSoldInPaisa).toBe(0);
    expect(report!.adjustmentsInPaisa).toBe(0);
    // No activity before this restaurant's opening balance either — opening
    // and closing valuation both carry the opening-balance amount forward.
    expect(report!.openingValuationInPaisa).toBe(report!.closingValuationInPaisa);
  });

  it("returns null when no Inventory account is mapped for this restaurant", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [unmappedRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-inv-val-unmapped-${suffix}`, name: "TEST Unmapped Restaurant" })
      .returning({ id: schema.restaurants.id });

    try {
      const report = await inventoryLib.getInventoryValuationReport({
        restaurantId: unmappedRestaurant.id,
        fromDate: "2026-05-01",
        toDate: "2026-05-31",
      });
      expect(report).toBeNull();
    } finally {
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, unmappedRestaurant.id));
    }
  });

  it("returns null when the mapped Inventory account has been deactivated", async () => {
    await db
      .update(schema.chartOfAccounts)
      .set({ isActive: false })
      .where(eq(schema.chartOfAccounts.id, inventoryAccountId));

    try {
      const report = await inventoryLib.getInventoryValuationReport({
        restaurantId,
        fromDate: "2026-05-01",
        toDate: "2026-05-31",
      });
      expect(report).toBeNull();
    } finally {
      await db
        .update(schema.chartOfAccounts)
        .set({ isActive: true })
        .where(eq(schema.chartOfAccounts.id, inventoryAccountId));
    }
  });
});
