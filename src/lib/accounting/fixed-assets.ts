import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import {
  fixedAssets,
  fixedAssetDepreciationEntries,
  chartOfAccounts,
  branches,
  type fixedAssetDepreciationMethodEnum,
} from "@/db/schema";
import { postVoucher, AccountingError, type PostedVoucher } from "./post-voucher";
import { resolveAccountMappings } from "./account-mappings";
import { MAPPING_KEYS } from "./account-mapping-keys";
import { resolveBankAccountForPosting } from "./bank-accounts";

/**
 * Phase 5, Slice 5d — Fixed Assets + book-purposes-only straight-line
 * depreciation. Per ACCOUNTING_PHASE_5_PLAN.md (Slice 5d) and sign-off
 * (AskUserQuestion, both "Recommended"): straight-line depreciation only,
 * explicitly for BOOK/management purposes — this module never claims to
 * compute a Nepal tax depreciation schedule (that stays an explicit,
 * unresearched Phase 6 question). Disposal supports optional cash/bank
 * proceeds and computes a real gain/loss (also sign-off, "Recommended").
 *
 * Same "wraps its own chart_of_accounts child row" pattern Slice 5b already
 * established for bank accounts: each fixed asset gets its own child
 * account under the seeded "1900 Fixed Assets", coded in the reserved
 * 1920-1999 block. Accumulated depreciation is NOT split per asset — every
 * asset shares the single seeded contra-asset "1910 Accumulated
 * Depreciation" account; this module's own fixedAssets.accumulatedDepreciationInPaisa
 * is a per-asset running total used only to cap a period's charge at the
 * asset's own salvage value, not a separate ledger account.
 */

const FIXED_ASSET_PARENT_CODE = "1900";
const FIXED_ASSET_CODE_BLOCK_START = 1920;
const FIXED_ASSET_CODE_BLOCK_END = 1999;
const ACCUMULATED_DEPRECIATION_CODE = "1910";
const DEPRECIATION_EXPENSE_CODE = "5150";
const GAIN_LOSS_ON_DISPOSAL_CODE = "4920";

export type FixedAssetDepreciationMethod = (typeof fixedAssetDepreciationMethodEnum.enumValues)[number];

export type FundingMethod = "cash" | "bank" | "credit";

export type FixedAssetRow = {
  id: string;
  chartOfAccountsId: string;
  name: string;
  category: string | null;
  acquisitionDate: string;
  costInPaisa: number;
  usefulLifeMonths: number;
  salvageValueInPaisa: number;
  depreciationMethod: FixedAssetDepreciationMethod;
  accumulatedDepreciationInPaisa: number;
  bookValueInPaisa: number;
  disposedAt: Date | null;
  disposalProceedsInPaisa: number | null;
  notes: string | null;
  code: string;
  accountName: string;
  isActive: boolean;
  createdAt: Date;
};

async function findAccountByCode(
  tx: Transaction,
  restaurantId: string,
  code: string,
  label: string,
): Promise<{ id: string }> {
  const [row] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.restaurantId, restaurantId), eq(chartOfAccounts.code, code)))
    .limit(1);
  if (!row) {
    throw new AccountingError(
      `This restaurant's chart of accounts hasn't been set up yet — seed it from the Overview tab before ${label}.`,
    );
  }
  return row;
}

/**
 * Every caller of this module posts a restaurant-wide voucher (a fixed
 * asset has no branch of its own) — same "default to the main branch"
 * convention the expense/payroll integrations already use for a
 * branchless event (see the expenses create route's own comment).
 */
export async function resolveMainBranchId(tx: Transaction, restaurantId: string): Promise<string> {
  const [row] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.restaurantId, restaurantId), eq(branches.isMain, true)))
    .limit(1);
  if (!row) {
    throw new AccountingError("This restaurant has no main branch configured.");
  }
  return row.id;
}

function toFixedAssetRow(row: {
  id: string;
  chartOfAccountsId: string;
  name: string;
  category: string | null;
  acquisitionDate: string;
  costInPaisa: number;
  usefulLifeMonths: number;
  salvageValueInPaisa: number;
  depreciationMethod: FixedAssetDepreciationMethod;
  accumulatedDepreciationInPaisa: number;
  disposedAt: Date | null;
  disposalProceedsInPaisa: number | null;
  notes: string | null;
  createdAt: Date;
  code: string;
  accountName: string;
  isActive: boolean;
}): FixedAssetRow {
  return {
    id: row.id,
    chartOfAccountsId: row.chartOfAccountsId,
    name: row.name,
    category: row.category,
    acquisitionDate: row.acquisitionDate,
    costInPaisa: row.costInPaisa,
    usefulLifeMonths: row.usefulLifeMonths,
    salvageValueInPaisa: row.salvageValueInPaisa,
    depreciationMethod: row.depreciationMethod,
    accumulatedDepreciationInPaisa: row.accumulatedDepreciationInPaisa,
    bookValueInPaisa: row.costInPaisa - row.accumulatedDepreciationInPaisa,
    disposedAt: row.disposedAt,
    disposalProceedsInPaisa: row.disposalProceedsInPaisa,
    notes: row.notes,
    code: row.code,
    accountName: row.accountName,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

/** Lists every fixed asset (active and disposed alike — the UI decides how to show a disposed one), newest acquisition first. */
export async function listFixedAssets(tx: Transaction, restaurantId: string): Promise<FixedAssetRow[]> {
  const rows = await tx
    .select({
      id: fixedAssets.id,
      chartOfAccountsId: fixedAssets.chartOfAccountsId,
      name: fixedAssets.name,
      category: fixedAssets.category,
      acquisitionDate: fixedAssets.acquisitionDate,
      costInPaisa: fixedAssets.costInPaisa,
      usefulLifeMonths: fixedAssets.usefulLifeMonths,
      salvageValueInPaisa: fixedAssets.salvageValueInPaisa,
      depreciationMethod: fixedAssets.depreciationMethod,
      accumulatedDepreciationInPaisa: fixedAssets.accumulatedDepreciationInPaisa,
      disposedAt: fixedAssets.disposedAt,
      disposalProceedsInPaisa: fixedAssets.disposalProceedsInPaisa,
      notes: fixedAssets.notes,
      createdAt: fixedAssets.createdAt,
      code: chartOfAccounts.code,
      accountName: chartOfAccounts.name,
      isActive: chartOfAccounts.isActive,
    })
    .from(fixedAssets)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, fixedAssets.chartOfAccountsId))
    .where(eq(fixedAssets.restaurantId, restaurantId))
    .orderBy(fixedAssets.acquisitionDate);
  return rows.map(toFixedAssetRow).reverse();
}

export type DepreciationEntryRow = {
  id: string;
  fixedAssetId: string;
  voucherId: string;
  periodStart: string;
  periodEnd: string;
  amountInPaisa: number;
  createdAt: Date;
};

/** One asset's own depreciation history, oldest first — the audit trail behind its running accumulated total. */
export async function listDepreciationEntries(
  tx: Transaction,
  params: { restaurantId: string; fixedAssetId: string },
): Promise<DepreciationEntryRow[]> {
  const rows = await tx
    .select()
    .from(fixedAssetDepreciationEntries)
    .where(
      and(
        eq(fixedAssetDepreciationEntries.restaurantId, params.restaurantId),
        eq(fixedAssetDepreciationEntries.fixedAssetId, params.fixedAssetId),
      ),
    )
    .orderBy(fixedAssetDepreciationEntries.periodEnd);
  return rows;
}

/**
 * Resolves the funding-source account for an acquisition (or the proceeds
 * destination on a disposal) — cash, a real bank account (per Slice 5b's
 * own picker/single-default rules), or Accounts Payable for a credit
 * purchase. Shared by acquisition and disposal since both are just "money
 * moved in or out through one of the same three doors."
 */
async function resolveFundingAccount(
  tx: Transaction,
  params: { restaurantId: string; method: FundingMethod; bankAccountId?: string | null },
): Promise<string> {
  if (params.method === "bank") {
    return resolveBankAccountForPosting(tx, {
      restaurantId: params.restaurantId,
      requestedBankAccountId: params.bankAccountId,
      legacyMappingKey: MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
    });
  }
  const key = params.method === "cash" ? MAPPING_KEYS.PAYMENT_METHOD_CASH : MAPPING_KEYS.ACCOUNTS_PAYABLE;
  const resolved = await resolveAccountMappings(tx, { restaurantId: params.restaurantId, keys: [key] });
  return resolved.get(key)!;
}

/**
 * Records a new fixed asset and posts its acquisition voucher in the same
 * transaction: Dr the asset's own auto-provisioned account (its full cost)
 * / Cr the funding source (cash, a real bank account, or Accounts Payable
 * for a credit purchase) — per the plan's own Slice 5d posting shape.
 */
export async function recordFixedAssetAcquisition(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    name: string;
    category?: string | null;
    acquisitionDate: string;
    costInPaisa: number;
    usefulLifeMonths: number;
    salvageValueInPaisa: number;
    fundingMethod: FundingMethod;
    bankAccountId?: string | null;
    notes?: string | null;
    createdByUserId: string;
  },
): Promise<{ fixedAsset: FixedAssetRow; voucher: PostedVoucher }> {
  if (!Number.isInteger(params.costInPaisa) || params.costInPaisa <= 0) {
    throw new AccountingError("Cost must be a positive amount.");
  }
  if (!Number.isInteger(params.usefulLifeMonths) || params.usefulLifeMonths <= 0) {
    throw new AccountingError("Useful life must be a positive number of months.");
  }
  if (
    !Number.isInteger(params.salvageValueInPaisa) ||
    params.salvageValueInPaisa < 0 ||
    params.salvageValueInPaisa > params.costInPaisa
  ) {
    throw new AccountingError("Salvage value must be between 0 and the asset's cost.");
  }

  const parent = await findAccountByCode(tx, params.restaurantId, FIXED_ASSET_PARENT_CODE, "adding a fixed asset");

  const [{ maxCode }] = await tx
    .select({ maxCode: sql<string | null>`max(${chartOfAccounts.code})` })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.restaurantId, params.restaurantId),
        sql`${chartOfAccounts.code} ~ '^[0-9]+$'`,
        sql`${chartOfAccounts.code}::int >= ${FIXED_ASSET_CODE_BLOCK_START}`,
        sql`${chartOfAccounts.code}::int <= ${FIXED_ASSET_CODE_BLOCK_END}`,
      ),
    );
  const nextCode = maxCode ? parseInt(maxCode, 10) + 1 : FIXED_ASSET_CODE_BLOCK_START;
  if (nextCode > FIXED_ASSET_CODE_BLOCK_END) {
    throw new AccountingError("This restaurant has reached the maximum number of fixed assets supported.");
  }

  const [account] = await tx
    .insert(chartOfAccounts)
    .values({
      restaurantId: params.restaurantId,
      code: String(nextCode),
      name: params.name,
      type: "asset",
      normalBalance: "debit",
      parentAccountId: parent.id,
      isSystemAccount: false,
    })
    .returning({ id: chartOfAccounts.id, code: chartOfAccounts.code, name: chartOfAccounts.name });

  const [asset] = await tx
    .insert(fixedAssets)
    .values({
      restaurantId: params.restaurantId,
      chartOfAccountsId: account.id,
      name: params.name,
      category: params.category || null,
      acquisitionDate: params.acquisitionDate,
      costInPaisa: params.costInPaisa,
      usefulLifeMonths: params.usefulLifeMonths,
      salvageValueInPaisa: params.salvageValueInPaisa,
      notes: params.notes || null,
      createdByUserId: params.createdByUserId,
    })
    .returning();

  const fundingAccountId = await resolveFundingAccount(tx, {
    restaurantId: params.restaurantId,
    method: params.fundingMethod,
    bankAccountId: params.bankAccountId,
  });

  const { voucher } = await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "fixed_asset",
    voucherDate: params.acquisitionDate,
    narration: `Fixed asset acquired — ${params.name}`,
    createdByUserId: params.createdByUserId,
    sourceType: "fixed_asset_acquisition",
    sourceId: asset.id,
    postingEvent: "acquired",
    lines: [
      { accountId: account.id, debitInPaisa: params.costInPaisa, description: params.name },
      { accountId: fundingAccountId, creditInPaisa: params.costInPaisa },
    ],
  });

  return {
    fixedAsset: toFixedAssetRow({ ...asset, code: account.code, accountName: account.name, isActive: true }),
    voucher,
  };
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

function parseDateParts(dateStr: string): { y: number; m: number; d: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { y, m, d };
}

/** Last day-of-month for a 1-based month number (1 = January). */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function lastDayOfMonthIso(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
}

/**
 * Book-purposes straight-line proration: a period entirely within one
 * calendar month is charged by actual-days-owned / actual-days-in-that-
 * month; a period spanning several months prorates only its first and last
 * (partial) segments by calendar days the same way, with every whole month
 * in between charged the flat monthly rate. This is what makes "an asset
 * bought mid-month" (the plan's own test case) come out right, and it
 * generalizes cleanly to a restaurant that skips a month and later runs a
 * multi-month catch-up in one go — not just the common "exactly one full
 * month" case.
 *
 * Deliberately NOT a 30/360 or other fixed day-count convention — real
 * calendar days, since this is book/management reporting, not a tax
 * computation with its own fixed convention (see this module's own
 * top-of-file comment on why Nepal tax depreciation stays out of scope).
 */
export function computeProratedDepreciationCharge(
  periodStart: string,
  periodEnd: string,
  monthlyRateInPaisa: number,
): number {
  const s = parseDateParts(periodStart);
  const e = parseDateParts(periodEnd);
  if (s.y > e.y || (s.y === e.y && s.m > e.m) || (s.y === e.y && s.m === e.m && s.d > e.d)) {
    return 0;
  }

  if (s.y === e.y && s.m === e.m) {
    const dim = daysInMonth(s.y, s.m);
    const daysOwned = e.d - s.d + 1;
    return Math.round((monthlyRateInPaisa * daysOwned) / dim);
  }

  const firstDim = daysInMonth(s.y, s.m);
  const firstDaysOwned = firstDim - s.d + 1;
  const firstCharge = Math.round((monthlyRateInPaisa * firstDaysOwned) / firstDim);

  const wholeMonths = (e.y - s.y) * 12 + (e.m - s.m) - 1;
  const wholeCharge = monthlyRateInPaisa * Math.max(0, wholeMonths);

  const lastDim = daysInMonth(e.y, e.m);
  const lastCharge = Math.round((monthlyRateInPaisa * e.d) / lastDim);

  return firstCharge + wholeCharge + lastCharge;
}

function addOneDay(dateStr: string): string {
  const { y, m, d } = parseDateParts(dateStr);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

export type DepreciationRunResult = {
  voucher: PostedVoucher | null;
  entries: Array<{ fixedAssetId: string; fixedAssetName: string; amountInPaisa: number }>;
  totalInPaisa: number;
};

/**
 * "Run Depreciation for <month>" — the plan's own periodic, human-triggered
 * action (deliberately not a background cron — see this module's own
 * top-of-file comment). For every active (not disposed) asset with
 * anything left to depreciate through the end of `year`/`month`, charges
 * the elapsed period since it was last depreciated (or its acquisition
 * date, if never yet) using computeProratedDepreciationCharge, capped so
 * an asset is never depreciated below its own salvage value. Posts ONE
 * voucher for the whole run with a paired Dr Depreciation Expense / Cr
 * Accumulated Depreciation line per asset actually charged (full per-asset
 * traceability, still balances trivially since every pair matches).
 *
 * Idempotent by construction, not by postVoucher's own source-idempotency
 * mechanism (deliberately unused here — see the inline comment below):
 * re-running for a month already fully processed finds every asset already
 * caught up through that date and simply posts nothing, returning
 * `voucher: null`. The one-row-per-asset-per-periodEnd unique index on
 * fixed_asset_depreciation_entries is the hard backstop against a genuine
 * concurrent double-run; a real collision there just fails the transaction
 * (this is a rare, deliberate monthly human action, not a high-concurrency
 * automatic trigger, so that's an acceptable failure mode rather than
 * something worth an onConflictDoNothing dance).
 */
export async function runDepreciation(
  tx: Transaction,
  params: { restaurantId: string; branchId: string; year: number; month: number; createdByUserId: string },
): Promise<DepreciationRunResult> {
  const periodEnd = lastDayOfMonthIso(params.year, params.month);

  const assets = await tx
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.restaurantId, params.restaurantId), sql`${fixedAssets.disposedAt} IS NULL`));

  type Charge = { assetId: string; assetName: string; accountId: string; periodStart: string; amountInPaisa: number };
  const charges: Charge[] = [];

  for (const asset of assets) {
    const [lastEntry] = await tx
      .select({ periodEnd: fixedAssetDepreciationEntries.periodEnd })
      .from(fixedAssetDepreciationEntries)
      .where(eq(fixedAssetDepreciationEntries.fixedAssetId, asset.id))
      .orderBy(sql`${fixedAssetDepreciationEntries.periodEnd} desc`)
      .limit(1);

    const periodStart = lastEntry ? addOneDay(lastEntry.periodEnd) : asset.acquisitionDate;
    if (periodStart > periodEnd) continue; // already caught up through (or beyond) this date

    const depreciableBase = asset.costInPaisa - asset.salvageValueInPaisa;
    const remaining = depreciableBase - asset.accumulatedDepreciationInPaisa;
    if (remaining <= 0) continue; // fully depreciated already

    const monthlyRate = Math.round(depreciableBase / asset.usefulLifeMonths);
    const rawCharge = computeProratedDepreciationCharge(periodStart, periodEnd, monthlyRate);
    const amountInPaisa = Math.min(rawCharge, remaining);
    if (amountInPaisa <= 0) continue;

    charges.push({
      assetId: asset.id,
      assetName: asset.name,
      accountId: asset.chartOfAccountsId,
      periodStart,
      amountInPaisa,
    });
  }

  if (charges.length === 0) {
    return { voucher: null, entries: [], totalInPaisa: 0 };
  }

  const depreciationExpenseAccount = await findAccountByCode(
    tx,
    params.restaurantId,
    DEPRECIATION_EXPENSE_CODE,
    "running depreciation",
  );
  const accumulatedDepreciationAccount = await findAccountByCode(
    tx,
    params.restaurantId,
    ACCUMULATED_DEPRECIATION_CODE,
    "running depreciation",
  );

  const lines = charges.flatMap((c) => [
    {
      accountId: depreciationExpenseAccount.id,
      debitInPaisa: c.amountInPaisa,
      description: c.assetName,
    },
    {
      accountId: accumulatedDepreciationAccount.id,
      creditInPaisa: c.amountInPaisa,
      description: c.assetName,
    },
  ]);

  const { voucher } = await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "depreciation",
    voucherDate: periodEnd,
    narration: `Depreciation run through ${periodEnd}`,
    createdByUserId: params.createdByUserId,
    lines,
  });

  for (const c of charges) {
    await tx.insert(fixedAssetDepreciationEntries).values({
      restaurantId: params.restaurantId,
      fixedAssetId: c.assetId,
      voucherId: voucher.id,
      periodStart: c.periodStart,
      periodEnd,
      amountInPaisa: c.amountInPaisa,
      createdByUserId: params.createdByUserId,
    });
    await tx
      .update(fixedAssets)
      .set({
        accumulatedDepreciationInPaisa: sql`${fixedAssets.accumulatedDepreciationInPaisa} + ${c.amountInPaisa}`,
        updatedAt: new Date(),
      })
      .where(eq(fixedAssets.id, c.assetId));
  }

  return {
    voucher,
    entries: charges.map((c) => ({ fixedAssetId: c.assetId, fixedAssetName: c.assetName, amountInPaisa: c.amountInPaisa })),
    totalInPaisa: charges.reduce((sum, c) => sum + c.amountInPaisa, 0),
  };
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/**
 * Disposes of a fixed asset — per sign-off (AskUserQuestion, "Recommended"):
 * supports optional cash/bank proceeds and computes a real gain/loss,
 * rather than only a zero-proceeds write-off. Posts:
 *
 *   Dr Accumulated Depreciation   [this asset's own accumulated so far]
 *   Dr Cash / Bank Account        [proceeds received, if any]
 *   Dr Gain/Loss on Disposal      [only if this is the balancing debit — a loss]
 *       Cr the asset's own account    [its full original cost]
 *       Cr Gain/Loss on Disposal      [only if this is the balancing credit — a gain]
 *
 * Always balances exactly by construction: accumulated + proceeds +
 * max(0,loss) === cost + max(0,gain), since gain/loss is defined as
 * proceeds − bookValue and bookValue === cost − accumulated. Deactivates
 * the asset's own chart_of_accounts row afterward so it can't accidentally
 * be posted to again (its balance is now exactly zero anyway).
 */
export async function disposeFixedAsset(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    fixedAssetId: string;
    disposalDate: string;
    proceedsInPaisa: number;
    proceedsMethod?: "cash" | "bank";
    bankAccountId?: string | null;
    createdByUserId: string;
  },
): Promise<{ fixedAsset: FixedAssetRow; voucher: PostedVoucher; gainOrLossInPaisa: number }> {
  const [asset] = await tx
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.id, params.fixedAssetId), eq(fixedAssets.restaurantId, params.restaurantId)))
    .limit(1);
  if (!asset) {
    throw new AccountingError("Fixed asset not found.");
  }
  if (asset.disposedAt) {
    throw new AccountingError("This fixed asset has already been disposed.");
  }
  if (!Number.isInteger(params.proceedsInPaisa) || params.proceedsInPaisa < 0) {
    throw new AccountingError("Proceeds must be a non-negative amount.");
  }

  const bookValueInPaisa = asset.costInPaisa - asset.accumulatedDepreciationInPaisa;
  const gainOrLossInPaisa = params.proceedsInPaisa - bookValueInPaisa;

  const gainLossAccount = await findAccountByCode(
    tx,
    params.restaurantId,
    GAIN_LOSS_ON_DISPOSAL_CODE,
    "disposing of a fixed asset",
  );

  const lines: Array<{ accountId: string; debitInPaisa?: number; creditInPaisa?: number; description?: string }> = [];
  if (asset.accumulatedDepreciationInPaisa > 0) {
    const accumulatedDepreciationAccount = await findAccountByCode(
      tx,
      params.restaurantId,
      ACCUMULATED_DEPRECIATION_CODE,
      "disposing of a fixed asset",
    );
    lines.push({
      accountId: accumulatedDepreciationAccount.id,
      debitInPaisa: asset.accumulatedDepreciationInPaisa,
      description: asset.name,
    });
  }
  if (params.proceedsInPaisa > 0) {
    const proceedsAccountId = await resolveFundingAccount(tx, {
      restaurantId: params.restaurantId,
      method: params.proceedsMethod ?? "cash",
      bankAccountId: params.bankAccountId,
    });
    lines.push({ accountId: proceedsAccountId, debitInPaisa: params.proceedsInPaisa, description: asset.name });
  }
  if (gainOrLossInPaisa < 0) {
    lines.push({ accountId: gainLossAccount.id, debitInPaisa: -gainOrLossInPaisa, description: asset.name });
  }
  lines.push({ accountId: asset.chartOfAccountsId, creditInPaisa: asset.costInPaisa, description: asset.name });
  if (gainOrLossInPaisa > 0) {
    lines.push({ accountId: gainLossAccount.id, creditInPaisa: gainOrLossInPaisa, description: asset.name });
  }

  const { voucher } = await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "fixed_asset",
    voucherDate: params.disposalDate,
    narration: `Fixed asset disposed — ${asset.name}`,
    createdByUserId: params.createdByUserId,
    sourceType: "fixed_asset_disposal",
    sourceId: asset.id,
    postingEvent: "disposed",
    lines,
  });

  const [updated] = await tx
    .update(fixedAssets)
    .set({
      disposedAt: new Date(),
      disposalVoucherId: voucher.id,
      disposalProceedsInPaisa: params.proceedsInPaisa,
      updatedAt: new Date(),
    })
    .where(eq(fixedAssets.id, asset.id))
    .returning();

  await tx
    .update(chartOfAccounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(chartOfAccounts.id, asset.chartOfAccountsId));

  const [account] = await tx
    .select({ code: chartOfAccounts.code, name: chartOfAccounts.name })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.id, asset.chartOfAccountsId))
    .limit(1);

  return {
    fixedAsset: toFixedAssetRow({ ...updated, code: account.code, accountName: account.name, isActive: false }),
    voucher,
    gainOrLossInPaisa,
  };
}
