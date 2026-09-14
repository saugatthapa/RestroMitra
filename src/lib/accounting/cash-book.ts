import "server-only";
import { and, eq, gte, lte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accountingVoucherLines, accountingVouchers, chartOfAccounts, bankAccounts } from "@/db/schema";
import { getAccountBalances, signedBalance } from "./balances";

/**
 * Phase 7, Slice 7a — Cash Book / Bank Book. A bookkeeper's classic report:
 * one account, one date range, an opening balance, every transaction in
 * between with a running balance, and a closing balance. This is
 * deliberately NOT a new computation — Phase 2's existing `getAccountLedger`
 * (balances.ts) already does "one account's full history with a running
 * balance," and this report reuses the exact same running-balance math
 * (`signedBalance`) and the exact same opening-balance source
 * (`getAccountBalances`, already used by Cash Flow (5c) for the same
 * purpose). What's new here is purely the date-range framing an ad-hoc
 * ledger view doesn't have: an opening balance AS OF `fromDate` (not
 * "since inception"), and only the lines that fall inside
 * [fromDate, toDate] — what an owner actually wants when they print "the
 * cash book for this month," as opposed to browsing an account's entire
 * history.
 *
 * "Cash Book" vs. "Bank Book" is purely a UI/picker distinction — both are
 * this exact same report, pointed at a different account. See
 * `listCashAndBankAccounts` below for which accounts populate that picker;
 * the report generator itself accepts any account belonging to the
 * restaurant (the same "no special-casing in the read path" posture
 * `getAccountLedger` already takes) so it can never disagree with the
 * generic Ledger Accounts screen about the same account's history.
 */

function subtractOneDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
}

// Same seeded cash-like codes Cash Flow (5c) treats as "cash" — see that
// module's own comment on why 1040/1045 count even though their names say
// "Bank": these are Slice 4d/4f's original default accounts, which may or
// may not yet be wrapped into a real `bank_accounts` row.
const CASH_SEED_CODES = ["1000", "1040", "1045"];

export type CashBookAccountOption = {
  accountId: string;
  code: string;
  name: string;
  isActive: boolean;
};

/**
 * The account picker for the Cash Book / Bank Book report: every seeded
 * cash-like account plus every real bank account this restaurant has ever
 * added (active or not — a since-deactivated bank account's historical
 * transactions are still real and still worth being able to print a book
 * for). Deliberately excludes clearing accounts (1010/1020/1030) and
 * Accounts Receivable/Payable — those aren't "money in a drawer or bank,"
 * same distinction Cash Flow (5c) already draws.
 */
export async function listCashAndBankAccounts(restaurantId: string): Promise<CashBookAccountOption[]> {
  const [seeded, wrapped] = await Promise.all([
    db
      .select({ id: chartOfAccounts.id, code: chartOfAccounts.code, name: chartOfAccounts.name, isActive: chartOfAccounts.isActive })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.restaurantId, restaurantId), inArray(chartOfAccounts.code, CASH_SEED_CODES))),
    db
      .select({ id: chartOfAccounts.id, code: chartOfAccounts.code, name: chartOfAccounts.name, isActive: chartOfAccounts.isActive })
      .from(bankAccounts)
      .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, bankAccounts.chartOfAccountsId))
      .where(eq(bankAccounts.restaurantId, restaurantId)),
  ]);
  const byId = new Map<string, CashBookAccountOption>();
  for (const row of [...seeded, ...wrapped]) {
    byId.set(row.id, { accountId: row.id, code: row.code, name: row.name, isActive: row.isActive });
  }
  return [...byId.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export type CashBookLine = {
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

export type CashBookReport = {
  account: { accountId: string; code: string; name: string };
  fromDate: string;
  toDate: string;
  openingBalanceInPaisa: number;
  closingBalanceInPaisa: number;
  totalDebitInPaisa: number;
  totalCreditInPaisa: number;
  lines: CashBookLine[];
};

export async function getCashBookReport(params: {
  restaurantId: string;
  accountId: string;
  fromDate: string;
  toDate: string;
}): Promise<CashBookReport | null> {
  const [account] = await db.select().from(chartOfAccounts).where(eq(chartOfAccounts.id, params.accountId));
  if (!account || account.restaurantId !== params.restaurantId) {
    return null;
  }

  const opening = await getAccountBalances({ restaurantId: params.restaurantId, toDate: subtractOneDay(params.fromDate) });
  const openingBalanceInPaisa = opening.accounts.find((a) => a.accountId === params.accountId)?.balanceInPaisa ?? 0;

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
    .where(
      and(
        eq(accountingVoucherLines.accountId, params.accountId),
        eq(accountingVouchers.restaurantId, params.restaurantId),
        gte(accountingVouchers.voucherDate, params.fromDate),
        lte(accountingVouchers.voucherDate, params.toDate),
      ),
    );

  rows.sort(
    (a, b) =>
      a.voucherDate.localeCompare(b.voucherDate) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  let running = openingBalanceInPaisa;
  let totalDebitInPaisa = 0;
  let totalCreditInPaisa = 0;
  const lines: CashBookLine[] = rows.map((r) => {
    running += signedBalance(account.normalBalance, r.debitInPaisa, r.creditInPaisa);
    totalDebitInPaisa += r.debitInPaisa;
    totalCreditInPaisa += r.creditInPaisa;
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

  return {
    account: { accountId: account.id, code: account.code, name: account.name },
    fromDate: params.fromDate,
    toDate: params.toDate,
    openingBalanceInPaisa,
    closingBalanceInPaisa: running,
    totalDebitInPaisa,
    totalCreditInPaisa,
    lines,
  };
}
