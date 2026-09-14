import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { accountingVoucherLines, accountingVouchers, chartOfAccounts } from "@/db/schema";

/**
 * Shared account-balance math for Phase 2's read screens (Overview, Chart
 * of Accounts, Ledger Accounts). Deliberately simple application-code
 * aggregation rather than a SQL GROUP BY — Phase 2 only ever has
 * manually-entered vouchers (Phase 4 hasn't wired anything in yet), so the
 * row counts involved are small; this can be revisited if/when Phase 4
 * integrations make voucher volume large enough for that to matter.
 *
 * A full Trial Balance / P&L / Balance Sheet report generator is Phase 3 —
 * this module only computes a single account's own current balance and a
 * restaurant-wide total-by-account-type, which is all Phase 2's UI needs.
 */

/** debit-normal: debit increases, credit decreases. credit-normal: the reverse. */
export function signedBalance(
  normalBalance: "debit" | "credit",
  totalDebitInPaisa: number,
  totalCreditInPaisa: number,
): number {
  return normalBalance === "debit"
    ? totalDebitInPaisa - totalCreditInPaisa
    : totalCreditInPaisa - totalDebitInPaisa;
}

export type AccountBalance = {
  accountId: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  normalBalance: "debit" | "credit";
  isActive: boolean;
  totalDebitInPaisa: number;
  totalCreditInPaisa: number;
  balanceInPaisa: number;
};

export async function getAccountBalances(params: {
  restaurantId: string;
  /** Inclusive. Omit for "since inception" (Phase 2's Overview/Chart of Accounts use). */
  fromDate?: string;
  /** Inclusive. Omit for "as of now". Financial statements (Phase 3) pass this. */
  toDate?: string;
  /**
   * Phase 7, Slice 7b — optionally scope every figure to one branch. Filters
   * the VOUCHER (not the account) by branchId, per this module's own
   * top-of-file schema comment on `accounting_vouchers.branchId`: "branch
   * reporting always works off the transaction, never depends on the
   * account being split per branch." So `accounts` below still lists every
   * account in the restaurant's chart (including restaurant-wide ones like
   * Sales Revenue or Accounts Payable) — branch scoping only narrows WHICH
   * VOUCHERS contribute to each account's balance, exactly mirroring how
   * every other branch-scoped report in this codebase (Reports dashboard's
   * `getReportSummary`) already treats branch filtering as a transaction-
   * level narrowing, not an account-level one.
   */
  branchId?: string;
}): Promise<{
  accounts: AccountBalance[];
  totalsByType: Record<AccountBalance["type"], number>;
}> {
  const accounts = await db
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.restaurantId, params.restaurantId));

  const conditions = [
    params.fromDate ? gte(accountingVouchers.voucherDate, params.fromDate) : undefined,
    params.toDate ? lte(accountingVouchers.voucherDate, params.toDate) : undefined,
    params.branchId ? eq(accountingVouchers.branchId, params.branchId) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const lines = await db
    .select({
      accountId: accountingVoucherLines.accountId,
      debitInPaisa: accountingVoucherLines.debitInPaisa,
      creditInPaisa: accountingVoucherLines.creditInPaisa,
    })
    .from(accountingVoucherLines)
    .innerJoin(accountingVouchers, eq(accountingVouchers.id, accountingVoucherLines.voucherId))
    .where(and(eq(accountingVouchers.restaurantId, params.restaurantId), ...conditions));

  const totalsByAccount = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const t = totalsByAccount.get(line.accountId) ?? { debit: 0, credit: 0 };
    t.debit += line.debitInPaisa;
    t.credit += line.creditInPaisa;
    totalsByAccount.set(line.accountId, t);
  }

  const totalsByType: Record<AccountBalance["type"], number> = {
    asset: 0,
    liability: 0,
    equity: 0,
    income: 0,
    expense: 0,
  };

  const result: AccountBalance[] = accounts.map((a) => {
    const t = totalsByAccount.get(a.id) ?? { debit: 0, credit: 0 };
    const balanceInPaisa = signedBalance(a.normalBalance, t.debit, t.credit);
    totalsByType[a.type] += balanceInPaisa;
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      normalBalance: a.normalBalance,
      isActive: a.isActive,
      totalDebitInPaisa: t.debit,
      totalCreditInPaisa: t.credit,
      balanceInPaisa,
    };
  });

  result.sort((a, b) => a.code.localeCompare(b.code));
  return { accounts: result, totalsByType };
}

export type LedgerLine = {
  lineId: string;
  voucherId: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  narration: string | null;
  description: string | null;
  debitInPaisa: number;
  creditInPaisa: number;
  runningBalanceInPaisa: number;
};

/**
 * One account's full transaction history in date order, with a running
 * balance — what Phase 2's Ledger Accounts screen needs to satisfy the
 * plan's own Phase 2 exit criteria ("see it in ... both accounts' ledgers
 * with a correct running balance"). Ties break on the voucher's createdAt
 * (insertion order) so two same-day vouchers still get a stable, sensible
 * running-balance sequence.
 */
export async function getAccountLedger(params: {
  restaurantId: string;
  accountId: string;
}): Promise<{ account: AccountBalance | null; lines: LedgerLine[] }> {
  const [account] = await db
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.id, params.accountId));
  if (!account || account.restaurantId !== params.restaurantId) {
    return { account: null, lines: [] };
  }

  const rows = await db
    .select({
      lineId: accountingVoucherLines.id,
      voucherId: accountingVouchers.id,
      voucherNumber: accountingVouchers.voucherNumber,
      voucherType: accountingVouchers.voucherType,
      voucherDate: accountingVouchers.voucherDate,
      narration: accountingVouchers.narration,
      description: accountingVoucherLines.description,
      debitInPaisa: accountingVoucherLines.debitInPaisa,
      creditInPaisa: accountingVoucherLines.creditInPaisa,
      createdAt: accountingVouchers.createdAt,
    })
    .from(accountingVoucherLines)
    .innerJoin(accountingVouchers, eq(accountingVouchers.id, accountingVoucherLines.voucherId))
    .where(eq(accountingVoucherLines.accountId, params.accountId));

  rows.sort(
    (a, b) =>
      a.voucherDate.localeCompare(b.voucherDate) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  let running = 0;
  const lines: LedgerLine[] = rows.map((r) => {
    running += signedBalance(account.normalBalance, r.debitInPaisa, r.creditInPaisa);
    return {
      lineId: r.lineId,
      voucherId: r.voucherId,
      voucherNumber: r.voucherNumber,
      voucherType: r.voucherType,
      voucherDate: r.voucherDate,
      narration: r.narration,
      description: r.description,
      debitInPaisa: r.debitInPaisa,
      creditInPaisa: r.creditInPaisa,
      runningBalanceInPaisa: running,
    };
  });

  const totalDebit = rows.reduce((s, r) => s + r.debitInPaisa, 0);
  const totalCredit = rows.reduce((s, r) => s + r.creditInPaisa, 0);

  return {
    account: {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      normalBalance: account.normalBalance,
      isActive: account.isActive,
      totalDebitInPaisa: totalDebit,
      totalCreditInPaisa: totalCredit,
      balanceInPaisa: signedBalance(account.normalBalance, totalDebit, totalCredit),
    },
    lines,
  };
}
