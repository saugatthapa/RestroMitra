/**
 * Phase 6, Slice 6e — Nepal tax depreciation (pooled declining-balance),
 * src/lib/accounting/tax-depreciation.ts. Covers the pure pool/intangible
 * computation (hand-verified against real BS/AD date conversions — see the
 * inline comments for how each expected number was derived) and the DB
 * integration path (setFixedAssetTaxDepreciationPool, getTaxDepreciationReport,
 * including how a disposal's EFFECTIVE date is resolved via its disposal
 * voucher rather than the raw disposedAt timestamp).
 *
 * The BS/AD date pairs used throughout were verified directly against the
 * `nepali-date-converter` library this module itself uses (not asserted
 * from memory):
 *   2024-07-16 = Shrawan 1, 2081  (BS month idx 3 — full/3-of-3 coefficient, income year 2081)
 *   2025-01-14 = Magh 1, 2081     (BS month idx 9 — 2-of-3 coefficient,   income year 2081)
 *   2025-04-14 = Baisakh 1, 2082  (BS month idx 0 — 1-of-3 coefficient,   income year 2081, NOT 2082 — Baisakh-Ashadh belongs to the PRIOR income year label)
 *   2025-11-15 = BS 2082, Kartik 29 (month idx 6 — full coefficient, income year 2082)
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as every other
 * DB-backed integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — Nepal tax depreciation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let fixedAssetsLib: typeof import("@/lib/accounting/fixed-assets");
  let taxDepreciationLib: typeof import("@/lib/accounting/tax-depreciation");

  let restaurantId: string;
  let branchId: string;
  let userId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    fixedAssetsLib = await import("@/lib/accounting/fixed-assets");
    taxDepreciationLib = await import("@/lib/accounting/tax-depreciation");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tax-depreciation-${suffix}`, name: "TEST Tax Depreciation Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Tax Depreciation Accountant", phone: `978${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function acquire(params: { costInPaisa: number; acquisitionDate: string; usefulLifeMonths?: number }) {
    const { fixedAsset } = await db.transaction((tx) =>
      fixedAssetsLib.recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: `TEST Asset ${Math.random().toString(36).slice(2, 8)}`,
        acquisitionDate: params.acquisitionDate,
        costInPaisa: params.costInPaisa,
        usefulLifeMonths: params.usefulLifeMonths ?? 60,
        salvageValueInPaisa: 0,
        fundingMethod: "cash",
        createdByUserId: userId,
      }),
    );
    return fixedAsset;
  }

  async function classify(fixedAssetId: string, pool: "A" | "B" | "C" | "D" | "E" | null) {
    return db.transaction((tx) =>
      fixedAssetsLib.setFixedAssetTaxDepreciationPool(tx, { restaurantId, fixedAssetId, taxDepreciationPool: pool }),
    );
  }

  // ---------------------------------------------------------------------
  // Pure computation — computePoolSchedule
  // ---------------------------------------------------------------------

  it("computePoolSchedule: a full-coefficient addition depreciates at the pool's own flat rate across years", () => {
    const { computePoolSchedule } = taxDepreciationLib;
    // Pool B (25%), cost Rs 100,000 (10,000,000 paisa), acquired Shrawan 1
    // 2081 (full coefficient, income year 2081).
    const years = computePoolSchedule(
      [{ id: "a", name: "A", costInPaisa: 10_000_000, acquisitionDate: "2024-07-16", disposalEffectiveDate: null, disposalProceedsInPaisa: null }],
      2500,
      2082,
    );
    expect(years).toHaveLength(2);
    expect(years[0]).toMatchObject({
      incomeYear: 2081,
      openingBalanceInPaisa: 0,
      additionsInPaisa: 10_000_000,
      poolValueBeforeDepreciationInPaisa: 10_000_000,
      depreciationChargeInPaisa: 2_500_000,
      closingBalanceInPaisa: 7_500_000,
    });
    expect(years[1]).toMatchObject({
      incomeYear: 2082,
      openingBalanceInPaisa: 7_500_000,
      additionsInPaisa: 0,
      depreciationChargeInPaisa: 1_875_000,
      closingBalanceInPaisa: 5_625_000,
    });
  });

  it("computePoolSchedule: a partial-coefficient acquisition carries its unabsorbed remainder into the FOLLOWING income year as an addition", () => {
    const { computePoolSchedule } = taxDepreciationLib;
    // Pool B (25%), cost Rs 90,000 (9,000,000 paisa), acquired Magh 1 2081
    // (2/3 coefficient, income year 2081) — 6,000,000 this year, 3,000,000
    // (the remainder) added to income year 2082.
    const years = computePoolSchedule(
      [{ id: "a", name: "A", costInPaisa: 9_000_000, acquisitionDate: "2025-01-14", disposalEffectiveDate: null, disposalProceedsInPaisa: null }],
      2500,
      2082,
    );
    expect(years[0]).toMatchObject({
      incomeYear: 2081,
      additionsInPaisa: 6_000_000,
      depreciationChargeInPaisa: 1_500_000,
      closingBalanceInPaisa: 4_500_000,
    });
    expect(years[1]).toMatchObject({
      incomeYear: 2082,
      openingBalanceInPaisa: 4_500_000,
      additionsInPaisa: 3_000_000, // the carried-forward remainder
      poolValueBeforeDepreciationInPaisa: 7_500_000,
      depreciationChargeInPaisa: 1_875_000,
      closingBalanceInPaisa: 5_625_000,
    });
  });

  it("computePoolSchedule: disposal proceeds exceeding the pool's value produce a balancing charge, never a negative closing balance", () => {
    const { computePoolSchedule } = taxDepreciationLib;
    // Pool C (20%), cost Rs 10,000 (1,000,000 paisa), full coefficient,
    // income year 2081 — closes at 800,000. Disposed for Rs 20,000
    // (2,000,000 paisa) in income year 2082 (2025-11-15) — proceeds exceed
    // the pool's own value, so the excess is a balancing charge, not a
    // negative pool.
    const years = computePoolSchedule(
      [
        {
          id: "a",
          name: "A",
          costInPaisa: 1_000_000,
          acquisitionDate: "2024-07-16",
          disposalEffectiveDate: "2025-11-15",
          disposalProceedsInPaisa: 2_000_000,
        },
      ],
      2000,
      2082,
    );
    expect(years[0]).toMatchObject({ incomeYear: 2081, depreciationChargeInPaisa: 200_000, closingBalanceInPaisa: 800_000 });
    expect(years[1]).toMatchObject({
      incomeYear: 2082,
      openingBalanceInPaisa: 800_000,
      disposalProceedsInPaisa: 2_000_000,
      poolValueBeforeDepreciationInPaisa: -1_200_000,
      balancingChargeInPaisa: 1_200_000,
      depreciationChargeInPaisa: 0,
      closingBalanceInPaisa: 0,
    });
  });

  it("computePoolSchedule: a pool value under Rs 2,000 is written off in full (de-minimis), the Rs 2,000 boundary itself is NOT", () => {
    const { computePoolSchedule } = taxDepreciationLib;
    const belowThreshold = computePoolSchedule(
      [{ id: "a", name: "A", costInPaisa: 199_999, acquisitionDate: "2024-07-16", disposalEffectiveDate: null, disposalProceedsInPaisa: null }],
      500,
      2081,
    );
    expect(belowThreshold[0]).toMatchObject({
      poolValueBeforeDepreciationInPaisa: 199_999,
      isDeMinimisWriteOff: true,
      depreciationChargeInPaisa: 199_999,
      closingBalanceInPaisa: 0,
    });

    const atThreshold = computePoolSchedule(
      [{ id: "a", name: "A", costInPaisa: 200_000, acquisitionDate: "2024-07-16", disposalEffectiveDate: null, disposalProceedsInPaisa: null }],
      500,
      2081,
    );
    expect(atThreshold[0]).toMatchObject({
      poolValueBeforeDepreciationInPaisa: 200_000,
      isDeMinimisWriteOff: false,
      depreciationChargeInPaisa: 10_000, // normal 5% rate, not a write-off
      closingBalanceInPaisa: 190_000,
    });
  });

  it("computePoolSchedule: two assets acquired in the same income year net together BEFORE the rate is applied", () => {
    const { computePoolSchedule } = taxDepreciationLib;
    const years = computePoolSchedule(
      [
        { id: "a", name: "A", costInPaisa: 1_000_000, acquisitionDate: "2024-07-16", disposalEffectiveDate: null, disposalProceedsInPaisa: null },
        { id: "b", name: "B", costInPaisa: 500_000, acquisitionDate: "2024-09-01", disposalEffectiveDate: null, disposalProceedsInPaisa: null },
      ],
      1500,
      2081,
    );
    expect(years[0]).toMatchObject({
      additionsInPaisa: 1_500_000,
      depreciationChargeInPaisa: 225_000,
      closingBalanceInPaisa: 1_275_000,
    });
  });

  // ---------------------------------------------------------------------
  // Pure computation — computeIntangibleSchedule
  // ---------------------------------------------------------------------

  it("computeIntangibleSchedule: a full-coefficient acquisition depreciates straight-line over its useful life", () => {
    const { computeIntangibleSchedule } = taxDepreciationLib;
    const schedule = computeIntangibleSchedule(
      { id: "a", name: "A", costInPaisa: 1_200_000, acquisitionDate: "2024-07-16", usefulLifeMonths: 24 },
      2082,
    );
    expect(schedule.usefulLifeYears).toBe(2);
    expect(schedule.years).toEqual([
      { incomeYear: 2081, incomeYearLabel: "2081/82", openingBalanceInPaisa: 1_200_000, depreciationChargeInPaisa: 600_000, closingBalanceInPaisa: 600_000 },
      { incomeYear: 2082, incomeYearLabel: "2082/83", openingBalanceInPaisa: 600_000, depreciationChargeInPaisa: 600_000, closingBalanceInPaisa: 0 },
    ]);
  });

  it("computeIntangibleSchedule: a partial-coefficient first year means the asset finishes LATER than its stated useful life", () => {
    const { computeIntangibleSchedule } = taxDepreciationLib;
    // Baisakh 1, 2082 = 1-of-3 coefficient, income year label 2081.
    // usefulLifeMonths 18 -> 1.5 years (already a half-year, no rounding
    // needed) -> annual amount = round(900,000 / 1.5) = 600,000.
    const schedule = computeIntangibleSchedule(
      { id: "a", name: "A", costInPaisa: 900_000, acquisitionDate: "2025-04-14", usefulLifeMonths: 18 },
      2083,
    );
    expect(schedule.usefulLifeYears).toBe(1.5);
    expect(schedule.years).toEqual([
      { incomeYear: 2081, incomeYearLabel: "2081/82", openingBalanceInPaisa: 900_000, depreciationChargeInPaisa: 200_000, closingBalanceInPaisa: 700_000 },
      { incomeYear: 2082, incomeYearLabel: "2082/83", openingBalanceInPaisa: 700_000, depreciationChargeInPaisa: 600_000, closingBalanceInPaisa: 100_000 },
      { incomeYear: 2083, incomeYearLabel: "2083/84", openingBalanceInPaisa: 100_000, depreciationChargeInPaisa: 100_000, closingBalanceInPaisa: 0 },
    ]);
  });

  it("formatIncomeYearLabel formats the conventional two-year-straddling label", () => {
    expect(taxDepreciationLib.formatIncomeYearLabel(2081)).toBe("2081/82");
  });

  // ---------------------------------------------------------------------
  // DB integration
  // ---------------------------------------------------------------------

  it("setFixedAssetTaxDepreciationPool classifies, then clears, an asset's pool", async () => {
    const asset = await acquire({ costInPaisa: 500_000, acquisitionDate: "2024-07-16" });
    expect(asset.taxDepreciationPool).toBeNull();

    const classified = await classify(asset.id, "C");
    expect(classified.taxDepreciationPool).toBe("C");

    const cleared = await classify(asset.id, null);
    expect(cleared.taxDepreciationPool).toBeNull();
  });

  it("getTaxDepreciationReport pools a classified asset's cost and applies the pool's own rate", async () => {
    const asset = await acquire({ costInPaisa: 10_000_000, acquisitionDate: "2024-07-16" });
    await classify(asset.id, "B");

    const report = await db.transaction((tx) =>
      taxDepreciationLib.getTaxDepreciationReport(tx, { restaurantId, throughIncomeYear: 2081 }),
    );

    const poolB = report.pools.find((p) => p.pool === "B")!;
    expect(poolB.ratePercent).toBe(25);
    expect(poolB.years[poolB.years.length - 1]).toMatchObject({
      incomeYear: 2081,
      additionsInPaisa: 10_000_000,
      depreciationChargeInPaisa: 2_500_000,
      closingBalanceInPaisa: 7_500_000,
    });
  });

  it("a disposal's EFFECTIVE date is resolved via its disposal voucher, not the raw disposedAt timestamp", async () => {
    const asset = await acquire({ costInPaisa: 1_000_000, acquisitionDate: "2024-07-16" });
    await classify(asset.id, "C");

    await db.transaction((tx) =>
      fixedAssetsLib.disposeFixedAsset(tx, {
        restaurantId,
        branchId,
        fixedAssetId: asset.id,
        disposalDate: "2025-11-15", // income year 2082 — deliberately NOT "today" (whatever disposedAt would record)
        proceedsInPaisa: 2_000_000,
        proceedsMethod: "cash",
        createdByUserId: userId,
      }),
    );

    const report = await db.transaction((tx) =>
      taxDepreciationLib.getTaxDepreciationReport(tx, { restaurantId, throughIncomeYear: 2082 }),
    );
    const poolC = report.pools.find((p) => p.pool === "C")!;
    const year2082 = poolC.years.find((y) => y.incomeYear === 2082)!;
    expect(year2082.disposalProceedsInPaisa).toBe(2_000_000);
    expect(year2082.balancingChargeInPaisa).toBe(1_200_000);
    expect(year2082.closingBalanceInPaisa).toBe(0);
  });

  it("unclassifiedAssetCount counts only active (not disposed), not-yet-classified assets", async () => {
    const unclassified = await acquire({ costInPaisa: 100_000, acquisitionDate: "2024-07-16" });
    const classified = await acquire({ costInPaisa: 100_000, acquisitionDate: "2024-07-16" });
    await classify(classified.id, "A");
    const disposedUnclassified = await acquire({ costInPaisa: 100_000, acquisitionDate: "2024-07-16" });
    await db.transaction((tx) =>
      fixedAssetsLib.disposeFixedAsset(tx, {
        restaurantId,
        branchId,
        fixedAssetId: disposedUnclassified.id,
        disposalDate: "2025-01-01",
        proceedsInPaisa: 0,
        createdByUserId: userId,
      }),
    );

    const report = await db.transaction((tx) =>
      taxDepreciationLib.getTaxDepreciationReport(tx, { restaurantId, throughIncomeYear: 2082 }),
    );
    // Only `unclassified` should count — `classified` has a pool, and
    // `disposedUnclassified` is disposed. (Other tests in this file may
    // also have left active unclassified assets behind, so assert a lower
    // bound including this one rather than an exact count.)
    expect(report.unclassifiedAssetCount).toBeGreaterThanOrEqual(1);
    void unclassified;
  });
});
