import "server-only";
import { and, eq, gte, lte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accountingVoucherLines, accountingVouchers, chartOfAccounts, bankAccounts } from "@/db/schema";
import { getAccountBalances } from "./balances";
import { getProfitAndLoss } from "./financial-statements";
import type { AccountingVoucherType } from "./post-voucher";

/**
 * Phase 5, Slice 5c — Cash Flow Statement, indirect method. Sequenced last
 * among Phase 5's five slices (per ACCOUNTING_PHASE_5_PLAN.md's own Part 5
 * decision #5) since classifying investing/financing activity depends on
 * Fixed Assets (5d) and Loans (5e) existing as recognizable voucher
 * patterns — this module reads only existing voucher/account data, adding
 * no new schema of its own.
 *
 * "Cash accounts" for this statement are the seeded 1000 (Cash on Hand),
 * 1040 (Bank / Digital Payments) and 1045 (Bank Account) — Slice 4d/4f's
 * original defaults, which may or may not yet be wrapped into a
 * bank_accounts row (that wrapping is lazy, on first visit to the Bank
 * Accounts tab — see bank-accounts.ts's own comment) — UNION every real
 * bank account Slice 5b's own bank_accounts table lists, active or not
 * (a since-deactivated bank account's HISTORICAL lines still represent
 * real cash movements at the time they posted). Deliberately NOT the
 * clearing accounts (1010/1020/1030) — those are receivable-like
 * "money not yet actually in a real account" holding accounts, not cash.
 *
 * Classification is a genuine partition of every cash-touching voucher
 * line into Operating / Investing / Financing (never a residual/plug that
 * would silently absorb a classification gap) — `isReconciled` on the
 * result is a real correctness check: it can only be true if the
 * classification below is complete, since it's computed independently
 * from the (unrelated) sum of cash-account balances. Only the Operating
 * *section's own displayed sub-lines* use an indirect-style presentation
 * (Net Income + non-cash add-backs + a working-capital plug) — the plug
 * is sized to make the displayed lines sum to the already-verified true
 * Operating total, never the other way around. Investing and Financing
 * are shown as exact, direct line items (standard practice even within an
 * "indirect method" statement — only the Operating section's own internal
 * presentation differs between the two methods).
 */

const CASH_SEED_CODES = ["1000", "1040", "1045"];
const DEPRECIATION_EXPENSE_CODE = "5150";
const INTEREST_EXPENSE_CODE = "5160";
const LOAN_PARENT_CODE = "2400";

type CashFlowCategory = "operating" | "investing";

// Every voucher type EXCEPT "loan" gets one flat classification for any
// line that touches a cash account, regardless of which account is on the
// other side — "loan" is deliberately absent here since a single
// repayment voucher's one cash line can combine a Financing (principal)
// and an Operating (interest) portion at once; see classifyLoanVoucher
// below. "opening_balance" and "depreciation" are also absent: the former
// is a one-time historical cutover excluded from period activity entirely
// (its effect is already captured in the beginning-cash balance instead of
// being double-counted as a flow), and the latter never posts a cash line
// in the first place (Dr Depreciation Expense / Cr Accumulated
// Depreciation — see fixed-assets.ts's runDepreciation), so no rule is
// needed for it.
const VOUCHER_TYPE_CATEGORY: Partial<Record<AccountingVoucherType, CashFlowCategory>> = {
  journal: "operating",
  sales: "operating",
  purchase: "operating",
  payment: "operating",
  expense: "operating",
  refund: "operating",
  // Slice 4f's reconciliation voucher: Dr a real bank account / Cr a
  // clearing account (card/mobile-wallet/other) — collecting a sale
  // already recorded as revenue, not a cash-to-cash transfer (no other
  // voucher type in this codebase posts a genuine cash-to-cash transfer
  // today; if one is ever added, two equal-and-opposite "operating" lines
  // within the same voucher still net to exactly zero here).
  contra: "operating",
  payroll: "operating",
  fixed_asset: "investing",
};

export type CashFlowLine = { label: string; amountInPaisa: number };

export type CashFlowSection = { lines: CashFlowLine[]; totalInPaisa: number };

export type CashFlowStatement = {
  fromDate: string;
  toDate: string;
  branchId: string | null;
  beginningCashInPaisa: number;
  endingCashInPaisa: number;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChangeInCashInPaisa: number;
  /**
   * True only if the total of every classified cash line (operating +
   * investing + financing) matches the independently-computed change in
   * actual cash-account balances (endingCash - beginningCash) exactly —
   * see this module's own top-of-file comment for why that's a genuine
   * completeness check, not a guaranteed-true tautology.
   */
  isReconciled: boolean;
};

function subtractOneDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
}

async function resolveCashAccountIds(restaurantId: string): Promise<Set<string>> {
  const [seeded, wrapped] = await Promise.all([
    db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.restaurantId, restaurantId), inArray(chartOfAccounts.code, CASH_SEED_CODES))),
    db.select({ id: bankAccounts.chartOfAccountsId }).from(bankAccounts).where(eq(bankAccounts.restaurantId, restaurantId)),
  ]);
  return new Set([...seeded.map((r) => r.id), ...wrapped.map((r) => r.id)]);
}

async function resolveAccountId(restaurantId: string, code: string): Promise<string | null> {
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.restaurantId, restaurantId), eq(chartOfAccounts.code, code)))
    .limit(1);
  return row?.id ?? null;
}

async function resolveLoanPayableAccountIds(restaurantId: string): Promise<Set<string>> {
  const parentId = await resolveAccountId(restaurantId, LOAN_PARENT_CODE);
  if (!parentId) return new Set();
  const children = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.restaurantId, restaurantId), eq(chartOfAccounts.parentAccountId, parentId)));
  return new Set(children.map((r) => r.id));
}

/**
 * Splits one "loan" voucher's single cash line into its Financing
 * (principal) and Operating (interest) contributions. A receipt (cash
 * line is a debit — money in) is 100% Financing: recordLoanReceipt
 * (loans.ts) always posts exactly [Dr funding account, Cr the loan's own
 * Payable account], the full principal. A repayment (cash line is a
 * credit — money out) posts up to three lines
 * ([Dr Payable (principal, if any), Dr Interest Expense (interest, if
 * any), Cr funding account]) — the two other lines in the SAME voucher
 * tell us exactly how much of the cash outflow was principal vs interest,
 * so no amortization math or lookup into the loans/loan_payments tables is
 * needed here at all.
 */
function classifyLoanVoucherCashLine(
  cashLineNetAmount: number,
  otherLines: Array<{ accountId: string; debitInPaisa: number; creditInPaisa: number }>,
  loanPayableAccountIds: Set<string>,
  interestExpenseAccountId: string | null,
): { financingInPaisa: number; interestOperatingInPaisa: number } {
  if (cashLineNetAmount > 0) {
    // Receipt — entirely financing.
    return { financingInPaisa: cashLineNetAmount, interestOperatingInPaisa: 0 };
  }
  // Repayment — cashLineNetAmount is negative (money out). Split by the
  // sibling debit lines' own amounts, which by voucher-balance construction
  // sum to exactly |cashLineNetAmount|.
  let principal = 0;
  let interest = 0;
  for (const line of otherLines) {
    if (loanPayableAccountIds.has(line.accountId)) principal += line.debitInPaisa;
    else if (interestExpenseAccountId && line.accountId === interestExpenseAccountId) interest += line.debitInPaisa;
  }
  return { financingInPaisa: -principal, interestOperatingInPaisa: -interest };
}

export async function getCashFlowStatement(params: {
  restaurantId: string;
  fromDate: string;
  toDate: string;
  /** Phase 7, Slice 7b — see balances.ts' getAccountBalances comment on branchId. Cash-account RESOLUTION (which accounts count as cash) stays restaurant-wide; only the voucher activity read from them is branch-scoped. */
  branchId?: string;
}): Promise<CashFlowStatement> {
  const { restaurantId, fromDate, toDate, branchId } = params;

  const [cashAccountIds, loanPayableAccountIds, interestExpenseAccountId, beginningBalances, endingBalances, pnl] =
    await Promise.all([
      resolveCashAccountIds(restaurantId),
      resolveLoanPayableAccountIds(restaurantId),
      resolveAccountId(restaurantId, INTEREST_EXPENSE_CODE),
      getAccountBalances({ restaurantId, toDate: subtractOneDay(fromDate), branchId }),
      getAccountBalances({ restaurantId, toDate, branchId }),
      getProfitAndLoss({ restaurantId, fromDate, toDate, branchId }),
    ]);

  const beginningCashInPaisa = beginningBalances.accounts
    .filter((a) => cashAccountIds.has(a.accountId))
    .reduce((s, a) => s + a.balanceInPaisa, 0);
  const endingCashInPaisa = endingBalances.accounts
    .filter((a) => cashAccountIds.has(a.accountId))
    .reduce((s, a) => s + a.balanceInPaisa, 0);

  // Pass 1 — every non-loan voucher's cash-touching lines, classified flat
  // by voucher type.
  const flatRows =
    cashAccountIds.size === 0
      ? []
      : await db
          .select({
            voucherType: accountingVouchers.voucherType,
            debitInPaisa: accountingVoucherLines.debitInPaisa,
            creditInPaisa: accountingVoucherLines.creditInPaisa,
          })
          .from(accountingVoucherLines)
          .innerJoin(accountingVouchers, eq(accountingVouchers.id, accountingVoucherLines.voucherId))
          .where(
            and(
              eq(accountingVouchers.restaurantId, restaurantId),
              gte(accountingVouchers.voucherDate, fromDate),
              lte(accountingVouchers.voucherDate, toDate),
              inArray(accountingVoucherLines.accountId, [...cashAccountIds]),
              branchId ? eq(accountingVouchers.branchId, branchId) : undefined,
            ),
          );

  let operatingInPaisa = 0;
  let investingInPaisa = 0;
  let fixedAssetPurchasesInPaisa = 0;
  let fixedAssetProceedsInPaisa = 0;

  for (const row of flatRows) {
    if (row.voucherType === "loan" || row.voucherType === "opening_balance") continue; // handled separately / excluded
    const category = VOUCHER_TYPE_CATEGORY[row.voucherType as AccountingVoucherType];
    if (!category) continue; // "depreciation" never reaches here (no cash line exists); any future type defaults to no rule rather than a guess
    const netAmount = row.debitInPaisa - row.creditInPaisa;
    if (category === "operating") {
      operatingInPaisa += netAmount;
    } else {
      investingInPaisa += netAmount;
      if (netAmount < 0) fixedAssetPurchasesInPaisa += netAmount;
      else fixedAssetProceedsInPaisa += netAmount;
    }
  }

  // Pass 2 — "loan" vouchers, fetched with ALL of their lines (not just the
  // cash one) so classifyLoanVoucherCashLine can see the sibling
  // principal/interest lines within the same voucher.
  let financingInPaisa = 0;
  let loanReceiptsInPaisa = 0;
  let loanPrincipalRepaymentsInPaisa = 0;
  let interestOperatingInPaisa = 0;

  const loanVoucherIdRows = await db
    .select({ id: accountingVouchers.id })
    .from(accountingVouchers)
    .where(
      and(
        eq(accountingVouchers.restaurantId, restaurantId),
        eq(accountingVouchers.voucherType, "loan"),
        gte(accountingVouchers.voucherDate, fromDate),
        lte(accountingVouchers.voucherDate, toDate),
        branchId ? eq(accountingVouchers.branchId, branchId) : undefined,
      ),
    );

  if (loanVoucherIdRows.length > 0) {
    const loanVoucherIds = loanVoucherIdRows.map((r) => r.id);
    const allLoanLines = await db
      .select({
        voucherId: accountingVoucherLines.voucherId,
        accountId: accountingVoucherLines.accountId,
        debitInPaisa: accountingVoucherLines.debitInPaisa,
        creditInPaisa: accountingVoucherLines.creditInPaisa,
      })
      .from(accountingVoucherLines)
      .where(inArray(accountingVoucherLines.voucherId, loanVoucherIds));

    const byVoucher = new Map<string, typeof allLoanLines>();
    for (const line of allLoanLines) {
      const list = byVoucher.get(line.voucherId) ?? [];
      list.push(line);
      byVoucher.set(line.voucherId, list);
    }

    for (const lines of byVoucher.values()) {
      const cashLineIndex = lines.findIndex((l) => cashAccountIds.has(l.accountId));
      if (cashLineIndex === -1) continue; // shouldn't happen — every loan voucher has exactly one cash line
      const cashLine = lines[cashLineIndex];
      const otherLines = lines.filter((_, i) => i !== cashLineIndex);
      const netAmount = cashLine.debitInPaisa - cashLine.creditInPaisa;
      const { financingInPaisa: financingPortion, interestOperatingInPaisa: interestPortion } =
        classifyLoanVoucherCashLine(netAmount, otherLines, loanPayableAccountIds, interestExpenseAccountId);
      financingInPaisa += financingPortion;
      interestOperatingInPaisa += interestPortion;
      operatingInPaisa += interestPortion;
      if (financingPortion > 0) loanReceiptsInPaisa += financingPortion;
      else loanPrincipalRepaymentsInPaisa += financingPortion;
    }
  }

  // ---- Operating section: indirect-method presentation -------------------
  const netIncomeInPaisa = pnl.netIncomeInPaisa;
  const depreciationAddBackInPaisa = pnl.expenses.find((e) => e.code === DEPRECIATION_EXPENSE_CODE)?.amountInPaisa ?? 0;
  // Sized so the displayed lines sum to exactly `operatingInPaisa` (the
  // already-verified true total) — see this module's own top-of-file
  // comment on why the plug never masks a classification gap.
  const workingCapitalPlugInPaisa =
    operatingInPaisa - netIncomeInPaisa - depreciationAddBackInPaisa - interestOperatingInPaisa;

  const operatingLines: CashFlowLine[] = [
    { label: "Net income", amountInPaisa: netIncomeInPaisa },
    { label: "Add: Depreciation", amountInPaisa: depreciationAddBackInPaisa },
    { label: "Interest paid on loans", amountInPaisa: interestOperatingInPaisa },
    { label: "Changes in working capital and other operating activity", amountInPaisa: workingCapitalPlugInPaisa },
  ].filter((l) => l.amountInPaisa !== 0);

  const investingLines: CashFlowLine[] = [
    { label: "Purchase of fixed assets", amountInPaisa: fixedAssetPurchasesInPaisa },
    { label: "Proceeds from sale of fixed assets", amountInPaisa: fixedAssetProceedsInPaisa },
  ].filter((l) => l.amountInPaisa !== 0);

  const financingLines: CashFlowLine[] = [
    { label: "Loan received", amountInPaisa: loanReceiptsInPaisa },
    { label: "Repayment of loan principal", amountInPaisa: loanPrincipalRepaymentsInPaisa },
  ].filter((l) => l.amountInPaisa !== 0);

  const netChangeFromClassification = operatingInPaisa + investingInPaisa + financingInPaisa;
  const netChangeFromBalances = endingCashInPaisa - beginningCashInPaisa;

  return {
    fromDate,
    toDate,
    branchId: branchId ?? null,
    beginningCashInPaisa,
    endingCashInPaisa,
    operating: { lines: operatingLines, totalInPaisa: operatingInPaisa },
    investing: { lines: investingLines, totalInPaisa: investingInPaisa },
    financing: { lines: financingLines, totalInPaisa: financingInPaisa },
    netChangeInCashInPaisa: netChangeFromClassification,
    isReconciled: netChangeFromClassification === netChangeFromBalances,
  };
}
