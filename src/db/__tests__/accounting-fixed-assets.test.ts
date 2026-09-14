/**
 * Integration tests for src/lib/accounting/fixed-assets.ts — Phase 5,
 * Slice 5d's fixed asset acquisition, straight-line depreciation (incl.
 * the calendar-day proration a mid-month acquisition needs), and disposal
 * with proceeds/gain-loss (see that module's own doc comments for the full
 * reasoning this test suite exercises).
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — fixed assets (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let fixedAssetsLib: typeof import("@/lib/accounting/fixed-assets");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let cashAccountId: string;
  let accountsPayableAccountId: string;
  let depreciationExpenseAccountId: string;
  let accumulatedDepreciationAccountId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    fixedAssetsLib = await import("@/lib/accounting/fixed-assets");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-fixed-assets-${suffix}`, name: "TEST Fixed Assets Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Fixed Assets Accountant", phone: `977${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    const seeded = await db
      .select({ id: schema.chartOfAccounts.id, code: schema.chartOfAccounts.code })
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.restaurantId, restaurantId));
    const byCode = new Map(seeded.map((a) => [a.code, a.id]));
    cashAccountId = byCode.get("1000")!;
    accountsPayableAccountId = byCode.get("2000")!;
    depreciationExpenseAccountId = byCode.get("5150")!;
    accumulatedDepreciationAccountId = byCode.get("1910")!;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("computeProratedDepreciationCharge prorates a partial month by calendar days, charges whole months flat, and prorates a partial final month too", () => {
    const { computeProratedDepreciationCharge } = fixedAssetsLib;
    // Entirely within one 30-day month (June), owned from the 16th through
    // the 30th inclusive = 15 of 30 days = exactly half the monthly rate.
    expect(computeProratedDepreciationCharge("2026-06-16", "2026-06-30", 3000)).toBe(1500);
    // Entirely within a 31-day month (July): 10 of 31 days.
    expect(computeProratedDepreciationCharge("2026-07-01", "2026-07-10", 3100)).toBe(1000);
    // Multi-month span: partial June (15/30 days) + full July (flat) +
    // partial August (10/31 days), monthly rate 3100.
    const juneCharge = Math.round((3100 * 15) / 30); // 1550
    const augCharge = Math.round((3100 * 10) / 31); // 1000
    expect(computeProratedDepreciationCharge("2026-06-16", "2026-08-10", 3100)).toBe(
      juneCharge + 3100 + augCharge,
    );
    // A period ending before it starts is degenerate — charges nothing.
    expect(computeProratedDepreciationCharge("2026-08-01", "2026-07-01", 3100)).toBe(0);
  });

  it("recordFixedAssetAcquisition (cash) provisions a child account under 1900 in the reserved 1920-1999 block and posts a balanced voucher", async () => {
    const { fixedAsset, voucher } = await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: "TEST Kitchen Oven",
        category: "Kitchen Equipment",
        acquisitionDate: "2026-01-01",
        costInPaisa: 120_000_00,
        usefulLifeMonths: 60,
        salvageValueInPaisa: 12_000_00,
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    expect(Number(fixedAsset.code)).toBeGreaterThanOrEqual(1920);
    expect(Number(fixedAsset.code)).toBeLessThanOrEqual(1999);
    expect(fixedAsset.bookValueInPaisa).toBe(120_000_00);

    const [account] = await db
      .select()
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.id, fixedAsset.chartOfAccountsId));
    expect(account.type).toBe("asset");
    expect(account.normalBalance).toBe("debit");

    const [parent] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, "1900")));
    expect(account.parentAccountId).toBe(parent.id);

    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    expect(lines.length).toBe(2);
    const assetLine = lines.find((l) => l.accountId === fixedAsset.chartOfAccountsId)!;
    const cashLine = lines.find((l) => l.accountId === cashAccountId)!;
    expect(assetLine.debitInPaisa).toBe(120_000_00);
    expect(cashLine.creditInPaisa).toBe(120_000_00);
  });

  it("recordFixedAssetAcquisition (credit) credits Accounts Payable instead of cash", async () => {
    const { fixedAsset, voucher } = await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: "TEST POS Terminal (on credit)",
        acquisitionDate: "2026-01-05",
        costInPaisa: 60_000_00,
        usefulLifeMonths: 36,
        salvageValueInPaisa: 0,
        fundingMethod: "credit",
        createdByUserId: userId,
      }),
    );

    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    const apLine = lines.find((l) => l.accountId === accountsPayableAccountId)!;
    expect(apLine).toBeDefined();
    expect(apLine.creditInPaisa).toBe(60_000_00);

    const assetLine = lines.find((l) => l.accountId === fixedAsset.chartOfAccountsId)!;
    expect(assetLine.debitInPaisa).toBe(60_000_00);
  });

  it("rejects a salvage value greater than cost, and a non-positive cost, before touching the database", async () => {
    await expect(
      db.transaction((tx) =>
        fixedAssetsLib.recordFixedAssetAcquisition(tx, {
          restaurantId,
          branchId,
          name: "TEST Bad Asset",
          acquisitionDate: "2026-01-01",
          costInPaisa: 1000_00,
          usefulLifeMonths: 12,
          salvageValueInPaisa: 2000_00,
          fundingMethod: "cash",
          createdByUserId: userId,
        }),
      ),
    ).rejects.toThrow(/salvage value/i);

    await expect(
      db.transaction((tx) =>
        fixedAssetsLib.recordFixedAssetAcquisition(tx, {
          restaurantId,
          branchId,
          name: "TEST Zero-Cost Asset",
          acquisitionDate: "2026-01-01",
          costInPaisa: 0,
          usefulLifeMonths: 12,
          salvageValueInPaisa: 0,
          fundingMethod: "cash",
          createdByUserId: userId,
        }),
      ),
    ).rejects.toThrow(/cost must be/i);
  });

  it("runDepreciation charges a partial first month by calendar days for an asset acquired mid-month, across several assets with different useful lives, and is idempotent on re-run", async () => {
    // Acquired mid-month (Feb 16, a 28-day month in 2026) — depreciable
    // base 100,000 over 10 months = monthly rate 10,000; Feb 16-28
    // inclusive = 13 of 28 days.
    const { fixedAsset: assetA } = await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: "TEST Asset A (mid-month, 10mo life)",
        acquisitionDate: "2026-02-16",
        costInPaisa: 100_000_00,
        usefulLifeMonths: 10,
        salvageValueInPaisa: 0,
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );
    // Acquired on the 1st (a full month) — depreciable base 240,000 over
    // 24 months = monthly rate 10,000, charged in full for February.
    const { fixedAsset: assetB } = await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: "TEST Asset B (full month, 24mo life)",
        acquisitionDate: "2026-02-01",
        costInPaisa: 240_000_00,
        usefulLifeMonths: 24,
        salvageValueInPaisa: 0,
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    const result = await db.transaction((tx) =>
      fixedAssetsLib.runDepreciation(tx, { restaurantId, branchId, year: 2026, month: 2, createdByUserId: userId }),
    );

    expect(result.voucher).not.toBeNull();
    const chargeA = result.entries.find((e) => e.fixedAssetId === assetA.id)!;
    const chargeB = result.entries.find((e) => e.fixedAssetId === assetB.id)!;
    expect(chargeA.amountInPaisa).toBe(Math.round((10_000_00 * 13) / 28));
    expect(chargeB.amountInPaisa).toBe(10_000_00);

    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, result.voucher!.id));
    const totalDebit = lines.reduce((sum, l) => sum + l.debitInPaisa, 0);
    const totalCredit = lines.reduce((sum, l) => sum + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(lines.every((l) => l.accountId === depreciationExpenseAccountId || l.accountId === accumulatedDepreciationAccountId)).toBe(
      true,
    );

    // Re-running the SAME month posts nothing — both assets are already
    // caught up through Feb 28.
    const second = await db.transaction((tx) =>
      fixedAssetsLib.runDepreciation(tx, { restaurantId, branchId, year: 2026, month: 2, createdByUserId: userId }),
    );
    expect(second.voucher).toBeNull();
    expect(second.entries.length).toBe(0);

    // Running March charges a full month for both (flat monthly rate,
    // since March starts fresh on the 1st for both assets' own schedules).
    const march = await db.transaction((tx) =>
      fixedAssetsLib.runDepreciation(tx, { restaurantId, branchId, year: 2026, month: 3, createdByUserId: userId }),
    );
    const marchA = march.entries.find((e) => e.fixedAssetId === assetA.id)!;
    const marchB = march.entries.find((e) => e.fixedAssetId === assetB.id)!;
    expect(marchA.amountInPaisa).toBe(10_000_00);
    expect(marchB.amountInPaisa).toBe(10_000_00);
  });

  it("caps the final period's charge so an asset never depreciates below its own salvage value", async () => {
    // 1 month useful life, cost 10,000, salvage 1,000 — depreciable base
    // 9,000 over 1 month = the entire base is due in the first run.
    const { fixedAsset } = await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: "TEST Short-Life Asset",
        acquisitionDate: "2026-04-01",
        costInPaisa: 10_000_00,
        usefulLifeMonths: 1,
        salvageValueInPaisa: 1_000_00,
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );

    const april = await db.transaction((tx) =>
      fixedAssetsLib.runDepreciation(tx, { restaurantId, branchId, year: 2026, month: 4, createdByUserId: userId }),
    );
    const aprilCharge = april.entries.find((e) => e.fixedAssetId === fixedAsset.id)!;
    expect(aprilCharge.amountInPaisa).toBe(9_000_00);

    // A later run (May) has nothing left to charge — fully depreciated to
    // salvage value already.
    const may = await db.transaction((tx) =>
      fixedAssetsLib.runDepreciation(tx, { restaurantId, branchId, year: 2026, month: 5, createdByUserId: userId }),
    );
    expect(may.entries.find((e) => e.fixedAssetId === fixedAsset.id)).toBeUndefined();

    const [row] = await db.select().from(schema.fixedAssets).where(eq(schema.fixedAssets.id, fixedAsset.id));
    expect(row.accumulatedDepreciationInPaisa).toBe(9_000_00);
  });

  it("disposeFixedAsset nets the asset and its accumulated depreciation off the books and computes a gain/loss against proceeds", async () => {
    const { fixedAsset } = await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: "TEST Asset To Dispose",
        acquisitionDate: "2026-01-01",
        costInPaisa: 50_000_00,
        usefulLifeMonths: 10,
        salvageValueInPaisa: 0,
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );
    // Depreciate one month: monthly rate 5,000, full month for January.
    await db.transaction((tx) =>
      fixedAssetsLib.runDepreciation(tx, { restaurantId, branchId, year: 2026, month: 1, createdByUserId: userId }),
    );
    const [beforeDisposal] = await db
      .select()
      .from(schema.fixedAssets)
      .where(eq(schema.fixedAssets.id, fixedAsset.id));
    expect(beforeDisposal.accumulatedDepreciationInPaisa).toBe(5_000_00);
    // Book value is now 45,000. Sold for 40,000 cash — a 5,000 loss.
    const { voucher, gainOrLossInPaisa } = await db.transaction((tx) =>
      fixedAssetsLib.disposeFixedAsset(tx, {
        restaurantId,
        branchId,
        fixedAssetId: fixedAsset.id,
        disposalDate: "2026-02-01",
        proceedsInPaisa: 40_000_00,
        proceedsMethod: "cash",
        createdByUserId: userId,
      }),
    );
    expect(gainOrLossInPaisa).toBe(-5_000_00);

    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    const totalDebit = lines.reduce((sum, l) => sum + l.debitInPaisa, 0);
    const totalCredit = lines.reduce((sum, l) => sum + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);
    const assetLine = lines.find((l) => l.accountId === fixedAsset.chartOfAccountsId)!;
    expect(assetLine.creditInPaisa).toBe(50_000_00); // full original cost removed

    const [account] = await db
      .select()
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.id, fixedAsset.chartOfAccountsId));
    expect(account.isActive).toBe(false);

    const [afterDisposal] = await db
      .select()
      .from(schema.fixedAssets)
      .where(eq(schema.fixedAssets.id, fixedAsset.id));
    expect(afterDisposal.disposedAt).not.toBeNull();
    expect(afterDisposal.disposalProceedsInPaisa).toBe(40_000_00);

    // A disposed asset drops out of subsequent depreciation runs entirely.
    const march = await db.transaction((tx) =>
      fixedAssetsLib.runDepreciation(tx, { restaurantId, branchId, year: 2026, month: 3, createdByUserId: userId }),
    );
    expect(march.entries.find((e) => e.fixedAssetId === fixedAsset.id)).toBeUndefined();

    await expect(
      db.transaction((tx) =>
        fixedAssetsLib.disposeFixedAsset(tx, {
          restaurantId,
          branchId,
          fixedAssetId: fixedAsset.id,
          disposalDate: "2026-03-01",
          proceedsInPaisa: 0,
          createdByUserId: userId,
        }),
      ),
    ).rejects.toThrow(/already been disposed/);
  });

  it("disposeFixedAsset computes a gain when proceeds exceed book value", async () => {
    const { fixedAsset } = await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: "TEST Asset Sold At A Gain",
        acquisitionDate: "2026-01-01",
        costInPaisa: 20_000_00,
        usefulLifeMonths: 12,
        salvageValueInPaisa: 0,
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );
    // No depreciation run yet — book value is still the full 20,000. Sold
    // for 25,000 — a 5,000 gain.
    const { gainOrLossInPaisa, voucher } = await db.transaction((tx) =>
      fixedAssetsLib.disposeFixedAsset(tx, {
        restaurantId,
        branchId,
        fixedAssetId: fixedAsset.id,
        disposalDate: "2026-01-15",
        proceedsInPaisa: 25_000_00,
        proceedsMethod: "cash",
        createdByUserId: userId,
      }),
    );
    expect(gainOrLossInPaisa).toBe(5_000_00);
    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    const totalDebit = lines.reduce((sum, l) => sum + l.debitInPaisa, 0);
    const totalCredit = lines.reduce((sum, l) => sum + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);
  });
});
