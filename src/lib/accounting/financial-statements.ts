import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { branches } from "@/db/schema";
import { getAccountBalances, type AccountBalance } from "./balances";

/**
 * Phase 3 — Trial Balance, Profit & Loss, Balance Sheet.
 *
 * Cash Flow is deliberately NOT here (review correction #5 in
 * ACCOUNTING_MODULE_PLAN.md — it needs indirect-method reconciliation
 * against operating/investing/financing activity that only makes sense
 * once Phase 4's automatic postings exist; it's relocated to Phase 5).
 *
 * All three reports are built on top of getAccountBalances(), which already
 * does the debit/credit aggregation and signed-balance math — this module
 * only reshapes that into the three standard statement layouts and adds
 * the one genuinely new piece of math: the Balance Sheet's "Current Period
 * Earnings" line.
 */

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: AccountBalance["type"];
  debitInPaisa: number;
  creditInPaisa: number;
};

export type TrialBalance = {
  asOfDate: string | null;
  branchId: string | null;
  rows: TrialBalanceRow[];
  totalDebitInPaisa: number;
  totalCreditInPaisa: number;
  /**
   * True when the two column totals match, which the accounting identity
   * guarantees for any set of vouchers that individually balanced when
   * posted (postVoucher() refuses to post anything that doesn't) — see the
   * "Verification" note in ACCOUNTING_PHASE_3_REPORT.md for the proof.
   * Kept as an explicit computed flag anyway, rather than assumed, so a
   * genuine data problem (e.g. a row written outside postVoucher) surfaces
   * in the UI instead of silently producing a wrong-looking report.
   */
  isBalanced: boolean;
};

/**
 * Every active account, as of a date (or "since inception" if omitted),
 * split into Trial Balance columns. Each account's own signed balance is
 * placed on its normal-balance side when positive; an abnormal (negative)
 * balance is placed on the opposite side as a positive amount instead of
 * shown as a negative number, which is how a Trial Balance is conventionally
 * read. This split preserves the column-total identity even when abnormal
 * balances exist — see the proof note in ACCOUNTING_PHASE_3_REPORT.md.
 */
export async function getTrialBalance(params: {
  restaurantId: string;
  asOfDate?: string;
  /** Phase 7, Slice 7b — see getAccountBalances' own comment on branchId. */
  branchId?: string;
}): Promise<TrialBalance> {
  const { accounts } = await getAccountBalances({
    restaurantId: params.restaurantId,
    toDate: params.asOfDate,
    branchId: params.branchId,
  });

  const rows: TrialBalanceRow[] = accounts
    .filter((a) => a.balanceInPaisa !== 0)
    .map((a) => {
      const onNormalSide = a.balanceInPaisa >= 0;
      const amount = Math.abs(a.balanceInPaisa);
      const debitInPaisa = (a.normalBalance === "debit") === onNormalSide ? amount : 0;
      const creditInPaisa = (a.normalBalance === "credit") === onNormalSide ? amount : 0;
      return {
        accountId: a.accountId,
        code: a.code,
        name: a.name,
        type: a.type,
        debitInPaisa,
        creditInPaisa,
      };
    });

  const totalDebitInPaisa = rows.reduce((s, r) => s + r.debitInPaisa, 0);
  const totalCreditInPaisa = rows.reduce((s, r) => s + r.creditInPaisa, 0);

  return {
    asOfDate: params.asOfDate ?? null,
    branchId: params.branchId ?? null,
    rows,
    totalDebitInPaisa,
    totalCreditInPaisa,
    isBalanced: totalDebitInPaisa === totalCreditInPaisa,
  };
}

export type ProfitAndLossLine = { accountId: string; code: string; name: string; amountInPaisa: number };

export type ProfitAndLoss = {
  fromDate: string | null;
  toDate: string | null;
  branchId: string | null;
  income: ProfitAndLossLine[];
  expenses: ProfitAndLossLine[];
  totalIncomeInPaisa: number;
  totalExpenseInPaisa: number;
  netIncomeInPaisa: number;
};

/**
 * Income and expense activity for a period (both bounds optional — omit
 * both for "since inception"). Only income/expense accounts appear; a
 * balance-sheet account with activity in the period doesn't belong on a
 * P&L regardless of date range.
 */
export async function getProfitAndLoss(params: {
  restaurantId: string;
  fromDate?: string;
  toDate?: string;
  /** Phase 7, Slice 7b — see getAccountBalances' own comment on branchId. */
  branchId?: string;
}): Promise<ProfitAndLoss> {
  const { accounts } = await getAccountBalances({
    restaurantId: params.restaurantId,
    fromDate: params.fromDate,
    toDate: params.toDate,
    branchId: params.branchId,
  });

  const toLine = (a: AccountBalance): ProfitAndLossLine => ({
    accountId: a.accountId,
    code: a.code,
    name: a.name,
    amountInPaisa: a.balanceInPaisa,
  });

  const income = accounts.filter((a) => a.type === "income" && a.balanceInPaisa !== 0).map(toLine);
  const expenses = accounts.filter((a) => a.type === "expense" && a.balanceInPaisa !== 0).map(toLine);

  const totalIncomeInPaisa = income.reduce((s, l) => s + l.amountInPaisa, 0);
  const totalExpenseInPaisa = expenses.reduce((s, l) => s + l.amountInPaisa, 0);

  return {
    fromDate: params.fromDate ?? null,
    toDate: params.toDate ?? null,
    branchId: params.branchId ?? null,
    income,
    expenses,
    totalIncomeInPaisa,
    totalExpenseInPaisa,
    netIncomeInPaisa: totalIncomeInPaisa - totalExpenseInPaisa,
  };
}

export type BalanceSheetLine = { accountId: string; code: string; name: string; amountInPaisa: number };

export type BalanceSheet = {
  asOfDate: string | null;
  branchId: string | null;
  assets: BalanceSheetLine[];
  liabilities: BalanceSheetLine[];
  equity: BalanceSheetLine[];
  /**
   * Net income since inception through asOfDate, computed the same way
   * getProfitAndLoss does, and folded into Equity as its own line — there
   * are no period-closing/retained-earnings-transfer entries yet (that's a
   * later phase), so without this line every posted sale or expense would
   * leave the sheet permanently out of balance. This is what makes
   * Assets == Liabilities + Equity hold arithmetically by construction; see
   * ACCOUNTING_PHASE_3_REPORT.md for why that's a construction guarantee,
   * not yet a claim of full financial-picture completeness (that's
   * Phase 4/5, once automatic postings exist for every operational event).
   */
  currentPeriodEarningsInPaisa: number;
  totalAssetsInPaisa: number;
  totalLiabilitiesInPaisa: number;
  totalEquityInPaisa: number;
  isBalanced: boolean;
};

export async function getBalanceSheet(params: {
  restaurantId: string;
  asOfDate?: string;
  /** Phase 7, Slice 7b — see getAccountBalances' own comment on branchId. */
  branchId?: string;
}): Promise<BalanceSheet> {
  const [{ accounts }, pnl] = await Promise.all([
    getAccountBalances({ restaurantId: params.restaurantId, toDate: params.asOfDate, branchId: params.branchId }),
    getProfitAndLoss({ restaurantId: params.restaurantId, toDate: params.asOfDate, branchId: params.branchId }),
  ]);

  const toLine = (a: AccountBalance): BalanceSheetLine => ({
    accountId: a.accountId,
    code: a.code,
    name: a.name,
    amountInPaisa: a.balanceInPaisa,
  });

  const assets = accounts.filter((a) => a.type === "asset" && a.balanceInPaisa !== 0).map(toLine);
  const liabilities = accounts.filter((a) => a.type === "liability" && a.balanceInPaisa !== 0).map(toLine);
  const equity = accounts.filter((a) => a.type === "equity" && a.balanceInPaisa !== 0).map(toLine);

  const totalAssetsInPaisa = assets.reduce((s, l) => s + l.amountInPaisa, 0);
  const totalLiabilitiesInPaisa = liabilities.reduce((s, l) => s + l.amountInPaisa, 0);
  const currentPeriodEarningsInPaisa = pnl.netIncomeInPaisa;
  const totalEquityInPaisa = equity.reduce((s, l) => s + l.amountInPaisa, 0) + currentPeriodEarningsInPaisa;

  return {
    asOfDate: params.asOfDate ?? null,
    branchId: params.branchId ?? null,
    assets,
    liabilities,
    equity,
    currentPeriodEarningsInPaisa,
    totalAssetsInPaisa,
    totalLiabilitiesInPaisa,
    totalEquityInPaisa,
    isBalanced: totalAssetsInPaisa === totalLiabilitiesInPaisa + totalEquityInPaisa,
  };
}

export type BranchProfitabilityRow = {
  branchId: string;
  branchName: string;
  isMain: boolean;
  totalIncomeInPaisa: number;
  totalExpenseInPaisa: number;
  netIncomeInPaisa: number;
};

export type BranchProfitability = {
  fromDate: string | null;
  toDate: string | null;
  branches: BranchProfitabilityRow[];
};

/**
 * Phase 7, Slice 7b — one restaurant's Profit & Loss broken out side by
 * side, one column per branch. Simply runs `getProfitAndLoss` once per
 * branch (branches are few per restaurant — the same "small row counts,
 * simple aggregation" trade-off this module's balances.ts already
 * documents) rather than a new SQL GROUP BY. `restrictToBranchIds`, when
 * given, limits the result to exactly those branches — the route passes
 * this for a caller whose own role grant is locked to one branch (per
 * `resolveRestaurantContext`'s `branchId`), so a branch-restricted staff
 * member's request for this report can never return another branch's
 * figures alongside their own; omit it for an unrestricted caller to see
 * every active branch.
 */
export async function getBranchProfitability(params: {
  restaurantId: string;
  fromDate?: string;
  toDate?: string;
  restrictToBranchIds?: string[];
}): Promise<BranchProfitability> {
  const branchRows = await db
    .select({ id: branches.id, name: branches.name, isMain: branches.isMain })
    .from(branches)
    .where(eq(branches.restaurantId, params.restaurantId));

  const restrict = params.restrictToBranchIds ? new Set(params.restrictToBranchIds) : null;
  const includedBranches = restrict ? branchRows.filter((b) => restrict.has(b.id)) : branchRows;

  const rows = await Promise.all(
    includedBranches.map(async (b): Promise<BranchProfitabilityRow> => {
      const pnl = await getProfitAndLoss({
        restaurantId: params.restaurantId,
        fromDate: params.fromDate,
        toDate: params.toDate,
        branchId: b.id,
      });
      return {
        branchId: b.id,
        branchName: b.name,
        isMain: b.isMain,
        totalIncomeInPaisa: pnl.totalIncomeInPaisa,
        totalExpenseInPaisa: pnl.totalExpenseInPaisa,
        netIncomeInPaisa: pnl.netIncomeInPaisa,
      };
    }),
  );

  rows.sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || a.branchName.localeCompare(b.branchName));

  return {
    fromDate: params.fromDate ?? null,
    toDate: params.toDate ?? null,
    branches: rows,
  };
}
