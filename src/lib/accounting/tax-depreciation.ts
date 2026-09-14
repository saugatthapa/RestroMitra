import "server-only";
import NepaliDate from "nepali-date-converter";
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import { fixedAssets, accountingVouchers } from "@/db/schema";
import type { FixedAssetTaxDepreciationPool } from "./fixed-assets";

/**
 * Phase 6, Slice 6e — Nepal tax depreciation (Income Tax Act 2058, Schedule
 * 2), the "pooled declining-balance" method, built as a SECOND, INDEPENDENT
 * computation alongside Slice 5d's existing straight-line BOOK depreciation
 * (fixed-assets.ts) — never a replacement, never touching that module's own
 * postings, `accumulatedDepreciationInPaisa`, or any other book field. This
 * whole module is read-only: it posts NOTHING to the ledger. It is a report
 * for the owner's/accountant's own reference, exactly like Slice 6c's VAT
 * Return — never a claim of being a filable IRD schedule.
 *
 * ⚠️ VERIFICATION STATUS (read before trusting a number this module
 * produces): the mechanics below were corroborated across several
 * independent secondary sources (Nepali CA-firm tax guides, sites that
 * purport to quote the Act's own clause text) — NOT against an official
 * government-gazette copy of the Act, which could not be reached during
 * research. Two pieces carry meaningfully lower confidence than the rest:
 * the disposal "balancing charge" mechanic (point 3 below) and the exact
 * partial-vs-full-pool-dissolution boundary within it; and how the pool E
 * (intangible) schedule's own first-year fraction should work, which the
 * sources never addressed directly (this module reuses the same
 * "thirds" first-year rule as pools A-D for consistency, per this module's
 * own choice, not a sourced fact about intangibles specifically). Every
 * number/date this module computes should be checked against the IRD or a
 * licensed Nepali chartered accountant before it is relied on for an actual
 * filing — see ACCOUNTING_PHASE_6_PLAN.md Part 5 #4, which flags this exact
 * category of number as "not really this engagement's to make."
 *
 * The five Schedule 2 pools (`fixedAssetTaxDepreciationPoolEnum`,
 * schema.ts):
 *   A — buildings/permanent structures ................... 5%
 *   B — computers, furniture, office equipment ........... 25%
 *   C — automobiles, buses, minibuses ..................... 20%
 *   D — construction/earth-moving equipment + catch-all .. 15%
 *   E — intangible assets — NOT pooled; straight-line, cost
 *       ÷ useful life rounded to the nearest half-year.
 *
 * Pools A-D share ONE aggregate running balance per pool per Nepali income
 * year (Shrawan 1 – Ashadh end, i.e. roughly mid-July to mid-July) —
 * additions and disposal proceeds net together BEFORE the flat rate is
 * applied, never computed per individual asset. A mid-year acquisition's
 * cost is split across its acquisition income year and the following one
 * using a fixed three-tier "thirds" coefficient based on which part of the
 * income year it fell in (not day-count proration — deliberately different
 * from Slice 5d's own book-depreciation proration, which IS day-count; this
 * is a different, tax-specific convention):
 *   Shrawan 1 – Poush end (first ~6 months) ............ full (3/3) this year
 *   Magh 1 – Chaitra end (next ~3 months) ............... 2/3 this year, 1/3 next
 *   Baisakh 1 – Ashadh end (last ~3 months) ............. 1/3 this year, 2/3 next
 *
 * A disposal's SALE PROCEEDS (not cost, not book value) are subtracted from
 * the pool in the income year of disposal. If that drives the pool's
 * pre-depreciation value negative, the excess is a "balancing charge" —
 * taxable income for that year, not a depreciation figure at all — and the
 * pool resets to zero going into the next year (this module reports the
 * balancing charge as its own field; it never tries to post it anywhere).
 * If the pool's pre-depreciation value is positive but under Rs. 2,000
 * (200,000 paisa), the ENTIRE remaining balance is written off as that
 * year's depreciation (a de-minimis rule) rather than continuing to decline
 * at the fixed rate indefinitely.
 *
 * This module reuses Slice 5d's own `fixedAssets` rows as its only input —
 * `costInPaisa`, `acquisitionDate`, `disposalProceedsInPaisa`, and the new
 * `taxDepreciationPool` classification (nullable; an asset has no pool
 * until an owner explicitly assigns one via setFixedAssetTaxDepreciationPool)
 * — without reading or writing any of that table's own book-depreciation
 * fields (`depreciationMethod`, `usefulLifeMonths` is reused only for pool
 * E's own life-based formula, `accumulatedDepreciationInPaisa`, etc.).
 */

const POOL_RATE_BASIS_POINTS: Record<"A" | "B" | "C" | "D", number> = {
  A: 500, // 5%
  B: 2500, // 25%
  C: 2000, // 20%
  D: 1500, // 15%
};

/** Rs. 2,000 in paisa — the de-minimis full-write-off threshold. */
const DE_MINIMIS_THRESHOLD_IN_PAISA = 200_000;

function parseIsoDate(isoDateOnly: string): Date {
  return new Date(`${isoDateOnly}T00:00:00`);
}

/** 3 = full year (Shrawan-Poush), 2 = two-thirds (Magh-Chaitra), 1 = one-third (Baisakh-Ashadh). BS month index: Baisakh=0 ... Chaitra=11. */
function coefficientNumerator(bsMonthIndex: number): 1 | 2 | 3 {
  if (bsMonthIndex >= 3 && bsMonthIndex <= 8) return 3; // Shrawan..Poush
  if (bsMonthIndex >= 9 && bsMonthIndex <= 11) return 2; // Magh..Chaitra
  return 1; // Baisakh..Ashadh (0,1,2)
}

/** The income-year label (the BS year its own Shrawan 1 falls in) a given BS year/month belongs to. Baisakh-Ashadh (month 0-2) belong to the PREVIOUS BS year's label. */
function incomeYearLabel(bsYear: number, bsMonthIndex: number): number {
  return bsMonthIndex <= 2 ? bsYear - 1 : bsYear;
}

function incomeYearOf(adDate: Date): { incomeYear: number; coefficient: 1 | 2 | 3 } {
  const nd = NepaliDate.fromAD(adDate);
  const bsYear = nd.getYear();
  const bsMonth = nd.getMonth();
  return { incomeYear: incomeYearLabel(bsYear, bsMonth), coefficient: coefficientNumerator(bsMonth) };
}

/** "2082/83" — the conventional two-year-straddling label for a BS income year. */
export function formatIncomeYearLabel(incomeYear: number): string {
  return `${incomeYear}/${String((incomeYear + 1) % 100).padStart(2, "0")}`;
}

export type PoolYearRow = {
  incomeYear: number;
  incomeYearLabel: string;
  openingBalanceInPaisa: number;
  additionsInPaisa: number;
  disposalProceedsInPaisa: number;
  poolValueBeforeDepreciationInPaisa: number;
  /** > 0 only when disposals drove the pool negative — taxable income for the year, not depreciation. Never posted anywhere by this module. */
  balancingChargeInPaisa: number;
  /** True when the pool's remaining value was written off in full under the Rs. 2,000 de-minimis rule rather than at the normal rate. */
  isDeMinimisWriteOff: boolean;
  depreciationChargeInPaisa: number;
  closingBalanceInPaisa: number;
};

type PooledAssetInput = {
  id: string;
  name: string;
  costInPaisa: number;
  acquisitionDate: string;
  disposalEffectiveDate: string | null;
  disposalProceedsInPaisa: number | null;
};

/**
 * The core pooled computation, pure (no DB access) so it's directly
 * unit-testable — see this module's own top-of-file comment for the
 * mechanics this implements.
 */
export function computePoolSchedule(
  assets: PooledAssetInput[],
  rateBasisPoints: number,
  throughIncomeYear: number,
): PoolYearRow[] {
  if (assets.length === 0) return [];

  const additionsByYear = new Map<number, number>();
  const disposalsByYear = new Map<number, number>();
  const addTo = (map: Map<number, number>, year: number, amount: number) => {
    if (amount === 0) return;
    map.set(year, (map.get(year) ?? 0) + amount);
  };

  let minYear = Infinity;
  for (const asset of assets) {
    const { incomeYear, coefficient } = incomeYearOf(parseIsoDate(asset.acquisitionDate));
    const year1Amount = Math.round((asset.costInPaisa * coefficient) / 3);
    const year2Amount = asset.costInPaisa - year1Amount; // the unabsorbed remainder, carried to next year
    addTo(additionsByYear, incomeYear, year1Amount);
    if (coefficient < 3) addTo(additionsByYear, incomeYear + 1, year2Amount);
    minYear = Math.min(minYear, incomeYear);

    if (asset.disposalEffectiveDate && asset.disposalProceedsInPaisa != null) {
      const { incomeYear: disposalYear } = incomeYearOf(parseIsoDate(asset.disposalEffectiveDate));
      addTo(disposalsByYear, disposalYear, asset.disposalProceedsInPaisa);
    }
  }

  if (minYear > throughIncomeYear) return [];

  const rows: PoolYearRow[] = [];
  let openingBalance = 0;
  for (let year = minYear; year <= throughIncomeYear; year++) {
    const additions = additionsByYear.get(year) ?? 0;
    const disposals = disposalsByYear.get(year) ?? 0;
    const poolValueBeforeDepreciation = openingBalance + additions - disposals;

    let balancingCharge = 0;
    let isDeMinimisWriteOff = false;
    let depreciationCharge = 0;
    let closingBalance = 0;

    if (poolValueBeforeDepreciation < 0) {
      balancingCharge = -poolValueBeforeDepreciation;
    } else if (poolValueBeforeDepreciation > 0 && poolValueBeforeDepreciation < DE_MINIMIS_THRESHOLD_IN_PAISA) {
      isDeMinimisWriteOff = true;
      depreciationCharge = poolValueBeforeDepreciation;
    } else if (poolValueBeforeDepreciation > 0) {
      depreciationCharge = Math.round((poolValueBeforeDepreciation * rateBasisPoints) / 10_000);
      closingBalance = poolValueBeforeDepreciation - depreciationCharge;
    }

    rows.push({
      incomeYear: year,
      incomeYearLabel: formatIncomeYearLabel(year),
      openingBalanceInPaisa: openingBalance,
      additionsInPaisa: additions,
      disposalProceedsInPaisa: disposals,
      poolValueBeforeDepreciationInPaisa: poolValueBeforeDepreciation,
      balancingChargeInPaisa: balancingCharge,
      isDeMinimisWriteOff,
      depreciationChargeInPaisa: depreciationCharge,
      closingBalanceInPaisa: closingBalance,
    });

    openingBalance = closingBalance;
  }

  return rows;
}

export type IntangibleYearRow = {
  incomeYear: number;
  incomeYearLabel: string;
  openingBalanceInPaisa: number;
  depreciationChargeInPaisa: number;
  closingBalanceInPaisa: number;
};

export type IntangibleSchedule = {
  fixedAssetId: string;
  name: string;
  costInPaisa: number;
  usefulLifeYears: number;
  years: IntangibleYearRow[];
};

type IntangibleAssetInput = {
  id: string;
  name: string;
  costInPaisa: number;
  acquisitionDate: string;
  usefulLifeMonths: number;
};

/**
 * Pool E — NOT pooled: one independent straight-line schedule per
 * intangible asset, cost ÷ useful life rounded to the nearest half-year.
 * Reuses the same "thirds" first-year coefficient as pools A-D for the
 * acquisition year, for consistency with the rest of this module's own
 * mechanic — the sources this module's research drew on never addressed
 * intangibles' own first-year treatment directly, so this is this module's
 * own choice, not a separately-sourced fact (see top-of-file comment).
 * Unlike a pool, there is no "unabsorbed remainder carried to next year" —
 * the shortfall simply means the asset finishes depreciating slightly later
 * than its stated useful life, the same way a half-year convention would.
 */
export function computeIntangibleSchedule(asset: IntangibleAssetInput, throughIncomeYear: number): IntangibleSchedule {
  const { incomeYear: acquisitionYear, coefficient } = incomeYearOf(parseIsoDate(asset.acquisitionDate));
  const usefulLifeYears = Math.max(0.5, Math.round((asset.usefulLifeMonths / 12) * 2) / 2);
  const annualAmountInPaisa = Math.round(asset.costInPaisa / usefulLifeYears);

  const years: IntangibleYearRow[] = [];
  if (acquisitionYear <= throughIncomeYear) {
    let openingBalance = asset.costInPaisa;
    for (let year = acquisitionYear; year <= throughIncomeYear && openingBalance > 0; year++) {
      const fraction = year === acquisitionYear ? coefficient / 3 : 1;
      const charge = Math.min(Math.round(annualAmountInPaisa * fraction), openingBalance);
      const closingBalance = openingBalance - charge;
      years.push({
        incomeYear: year,
        incomeYearLabel: formatIncomeYearLabel(year),
        openingBalanceInPaisa: openingBalance,
        depreciationChargeInPaisa: charge,
        closingBalanceInPaisa: closingBalance,
      });
      openingBalance = closingBalance;
    }
  }

  return {
    fixedAssetId: asset.id,
    name: asset.name,
    costInPaisa: asset.costInPaisa,
    usefulLifeYears,
    years,
  };
}

export type TaxDepreciationReport = {
  throughIncomeYear: number;
  throughIncomeYearLabel: string;
  pools: Array<{
    pool: "A" | "B" | "C" | "D";
    ratePercent: number;
    assetCount: number;
    years: PoolYearRow[];
  }>;
  intangibles: IntangibleSchedule[];
  /** Active (not disposed), not-yet-classified assets — surfaced so the report can prompt the owner to classify them rather than silently omitting them. */
  unclassifiedAssetCount: number;
};

/**
 * The one function a route calls. Reads every classified fixed asset for
 * the restaurant (joining to accountingVouchers to resolve a disposed
 * asset's ACTUAL effective disposal date via its disposal voucher's own
 * voucherDate — not the disposedAt timestamp, which only records when the
 * disposal was entered into this app, not necessarily the same date),
 * groups by pool, and computes each pool's/intangible's schedule through
 * the requested income year (defaults to the current one).
 */
export async function getTaxDepreciationReport(
  tx: Transaction,
  params: { restaurantId: string; throughIncomeYear: number },
): Promise<TaxDepreciationReport> {
  const rows = await tx
    .select({
      id: fixedAssets.id,
      name: fixedAssets.name,
      costInPaisa: fixedAssets.costInPaisa,
      acquisitionDate: fixedAssets.acquisitionDate,
      usefulLifeMonths: fixedAssets.usefulLifeMonths,
      taxDepreciationPool: fixedAssets.taxDepreciationPool,
      disposalProceedsInPaisa: fixedAssets.disposalProceedsInPaisa,
      disposalVoucherDate: accountingVouchers.voucherDate,
    })
    .from(fixedAssets)
    .leftJoin(accountingVouchers, eq(accountingVouchers.id, fixedAssets.disposalVoucherId))
    .where(and(eq(fixedAssets.restaurantId, params.restaurantId), isNotNull(fixedAssets.taxDepreciationPool)));

  const pools: TaxDepreciationReport["pools"] = [];
  for (const pool of ["A", "B", "C", "D"] as const) {
    const assetsInPool = rows
      .filter((r) => r.taxDepreciationPool === pool)
      .map((r) => ({
        id: r.id,
        name: r.name,
        costInPaisa: r.costInPaisa,
        acquisitionDate: r.acquisitionDate,
        disposalEffectiveDate: r.disposalVoucherDate,
        disposalProceedsInPaisa: r.disposalProceedsInPaisa,
      }));
    pools.push({
      pool,
      ratePercent: POOL_RATE_BASIS_POINTS[pool] / 100,
      assetCount: assetsInPool.length,
      years: computePoolSchedule(assetsInPool, POOL_RATE_BASIS_POINTS[pool], params.throughIncomeYear),
    });
  }

  const intangibles = rows
    .filter((r) => r.taxDepreciationPool === "E")
    .map((r) =>
      computeIntangibleSchedule(
        { id: r.id, name: r.name, costInPaisa: r.costInPaisa, acquisitionDate: r.acquisitionDate, usefulLifeMonths: r.usefulLifeMonths },
        params.throughIncomeYear,
      ),
    );

  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(fixedAssets)
    .where(
      and(
        eq(fixedAssets.restaurantId, params.restaurantId),
        isNull(fixedAssets.taxDepreciationPool),
        isNull(fixedAssets.disposedAt),
      ),
    );

  return {
    throughIncomeYear: params.throughIncomeYear,
    throughIncomeYearLabel: formatIncomeYearLabel(params.throughIncomeYear),
    pools,
    intangibles,
    unclassifiedAssetCount: count,
  };
}

/** The Nepali (BS) income year label — the year its own Shrawan 1 falls in — that today (or a given AD date) falls within. */
export function currentIncomeYear(at: Date = new Date()): number {
  return incomeYearOf(at).incomeYear;
}

export type { FixedAssetTaxDepreciationPool };
