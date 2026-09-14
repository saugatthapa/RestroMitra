import "server-only";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import {
  accountMappings,
  accountingVoucherLines,
  accountingVouchers,
  chartOfAccounts,
  customers,
  suppliers,
} from "@/db/schema";
import { MAPPING_KEYS } from "./account-mapping-keys";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 5, Slice 5a — Accounts Receivable / Accounts Payable aging.
 *
 * `getSupplierDueReport` (supplier-dues.ts) and
 * `getCustomerOutstandingBalance(s)` (ledger.ts) already compute due/
 * outstanding figures today, but both read `ledger_entries` — Account
 * Books' own single-entry table — which every restaurant still writes to
 * regardless of whether they've enabled Phase 4's automatic posting. This
 * module is a SEPARATE, additive report that reads the double-entry
 * `accounting_voucher_lines` a Phase-4-enabled restaurant's own postings
 * populate — it changes nothing about the existing reports, and a
 * restaurant that hasn't enabled automatic posting (or hasn't seeded a
 * chart of accounts at all) simply gets `null` back, not an error.
 *
 * `accounting_voucher_lines.customerId`/`.supplierId` are documented on
 * the schema itself as "sub-ledger tags for drill-down/aging off the two
 * control accounts" — this is the first thing to actually read them for
 * that purpose.
 */

export type AgingBucketKey = "current" | "days1to30" | "days31to60" | "days61to90" | "over90";

export const AGING_BUCKET_KEYS: AgingBucketKey[] = [
  "current",
  "days1to30",
  "days31to60",
  "days61to90",
  "over90",
];

export type AgingRow = {
  partyId: string;
  partyName: string;
  outstandingInPaisa: number;
  buckets: Record<AgingBucketKey, number>;
  oldestChargeDate: string | null;
};

export type AgingReport = {
  asOfDate: string;
  branchId: string | null;
  controlAccountId: string;
  rows: AgingRow[];
  totalOutstandingInPaisa: number;
};

async function resolveControlAccountId(restaurantId: string, mappingKey: string): Promise<string | null> {
  const [row] = await db
    .select({ accountId: accountMappings.accountId, isActive: chartOfAccounts.isActive })
    .from(accountMappings)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, accountMappings.accountId))
    .where(and(eq(accountMappings.restaurantId, restaurantId), eq(accountMappings.mappingKey, mappingKey)))
    .limit(1);
  if (!row || !row.isActive) return null;
  return row.accountId;
}

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86_400_000);
}

function bucketFor(ageDays: number): AgingBucketKey {
  if (ageDays <= 0) return "current";
  if (ageDays <= 30) return "days1to30";
  if (ageDays <= 60) return "days31to60";
  if (ageDays <= 90) return "days61to90";
  return "over90";
}

type ChargeLot = { amountInPaisa: number; date: string };

/**
 * FIFO subledger reconstruction for one party (a supplier or customer)
 * against one control account: replays every tagged voucher line for that
 * party in (voucherDate, createdAt) order, opening a new dated "lot" for
 * each charge and consuming the oldest open lot(s) first for each payment
 * — the same oldest-first allocation `settleLedgerDue`/`settleCustomerCredit`
 * already use for the existing single-entry ledger. A payment that exceeds
 * every open lot becomes a running credit balance instead of a dated lot
 * (a real state — the restaurant overpaid a supplier, or a customer
 * overpaid their tab) that offsets the NEXT charge before it becomes a new
 * lot, rather than silently vanishing.
 *
 * A voucher reversal (a void) posts as an ordinary offsetting line on the
 * same account/party, not specially unwound against its own original lot
 * — so a charge voided long after other charges have accumulated nets
 * against whatever's oldest at the time, not necessarily itself. This can
 * occasionally assign a slightly different AGE to a few units of the
 * remaining balance than perfect invoice-level matching would, but the
 * TOTAL outstanding balance is always exactly correct regardless (it's
 * just sum(charges) - sum(payments) either way) — only the bucket split
 * could be marginally off in that rare ordering. Same simplicity
 * trade-off this codebase already made for `settleLedgerDue`'s own
 * oldest-first allocation, not a new one invented for this report.
 */
function runFifoAging(lines: { amountInPaisa: number; date: string; isCharge: boolean }[]): {
  lots: ChargeLot[];
  creditBalanceInPaisa: number;
} {
  const lots: ChargeLot[] = [];
  let creditBalance = 0;

  for (const line of lines) {
    if (line.isCharge) {
      let amount = line.amountInPaisa;
      if (creditBalance > 0) {
        const offset = Math.min(creditBalance, amount);
        creditBalance -= offset;
        amount -= offset;
      }
      if (amount > 0) lots.push({ amountInPaisa: amount, date: line.date });
      continue;
    }

    let remaining = line.amountInPaisa;
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const consumed = Math.min(lot.amountInPaisa, remaining);
      lot.amountInPaisa -= consumed;
      remaining -= consumed;
      if (lot.amountInPaisa === 0) lots.shift();
    }
    if (remaining > 0) creditBalance += remaining;
  }

  return { lots, creditBalanceInPaisa: creditBalance };
}

async function computeAging(params: {
  restaurantId: string;
  controlAccountId: string;
  /** Which side of a line is a "charge" (increases what's owed) for this control account's own normal balance — credit for a liability (AP), debit for an asset (AR). */
  chargeSide: "debit" | "credit";
  partyTable: "supplier" | "customer";
  timezone: string;
  asOfDate?: string;
  /**
   * Phase 7, Slice 7b. Unlike the other reports this module's branchId
   * threading touched, this ISN'T a clean "narrow which vouchers count"
   * filter — the FIFO reconstruction below replays a party's full charge/
   * payment history in order, and a party isn't necessarily tied to one
   * branch (a customer could run a tab at Branch A and pay it off at
   * Branch B). Filtering to one branch's own lines means a payment made at
   * a DIFFERENT branch won't appear here to offset a charge recorded at
   * this one — so a branch-filtered aging report can show a party as more
   * "outstanding" at this branch than they actually are company-wide. This
   * is a genuine, documented limitation (surfaced in the UI too), not a
   * silent bug — it's still useful for "what does this branch's own
   * activity with this party look like," just not a claim about their
   * true consolidated balance.
   */
  branchId?: string;
}): Promise<AgingReport> {
  const asOfDate = params.asOfDate ?? restaurantDate(params.timezone);
  const partyColumn =
    params.partyTable === "supplier" ? accountingVoucherLines.supplierId : accountingVoucherLines.customerId;

  const rows = await db
    .select({
      partyId: partyColumn,
      debitInPaisa: accountingVoucherLines.debitInPaisa,
      creditInPaisa: accountingVoucherLines.creditInPaisa,
      voucherDate: accountingVouchers.voucherDate,
      createdAt: accountingVoucherLines.createdAt,
    })
    .from(accountingVoucherLines)
    .innerJoin(accountingVouchers, eq(accountingVoucherLines.voucherId, accountingVouchers.id))
    .where(
      and(
        eq(accountingVouchers.restaurantId, params.restaurantId),
        eq(accountingVoucherLines.accountId, params.controlAccountId),
        isNotNull(partyColumn),
        params.branchId ? eq(accountingVouchers.branchId, params.branchId) : undefined,
        // lte would exclude same-day lines dated exactly asOfDate if voucherDate
        // ever carried a time component — it doesn't (date-only column) — so a
        // plain string comparison is safe and matches postVoucher's own
        // toDateOnly() convention.
      ),
    )
    .orderBy(asc(accountingVouchers.voucherDate), asc(accountingVoucherLines.createdAt));

  const inRange = rows.filter((r) => r.voucherDate <= asOfDate);

  const byParty = new Map<string, typeof rows>();
  for (const row of inRange) {
    const key = row.partyId as string;
    if (!byParty.has(key)) byParty.set(key, []);
    byParty.get(key)!.push(row);
  }

  const resultRows: AgingRow[] = [];
  let totalOutstanding = 0;

  for (const [partyId, partyRows] of byParty) {
    const lines = partyRows.map((r) => {
      const isCharge = params.chargeSide === "debit" ? r.debitInPaisa > 0 : r.creditInPaisa > 0;
      const amount = isCharge
        ? params.chargeSide === "debit"
          ? r.debitInPaisa
          : r.creditInPaisa
        : params.chargeSide === "debit"
          ? r.creditInPaisa
          : r.debitInPaisa;
      return { amountInPaisa: amount, date: r.voucherDate, isCharge };
    });

    const { lots, creditBalanceInPaisa } = runFifoAging(lines);
    const outstanding = lots.reduce((sum, lot) => sum + lot.amountInPaisa, 0) - creditBalanceInPaisa;
    if (outstanding === 0) continue;

    const buckets: Record<AgingBucketKey, number> = {
      current: 0,
      days1to30: 0,
      days31to60: 0,
      days61to90: 0,
      over90: 0,
    };
    for (const lot of lots) {
      buckets[bucketFor(daysBetween(lot.date, asOfDate))] += lot.amountInPaisa;
    }
    if (creditBalanceInPaisa > 0) buckets.current -= creditBalanceInPaisa;

    resultRows.push({
      partyId,
      partyName: "", // filled in by the caller, which knows which table to join
      outstandingInPaisa: outstanding,
      buckets,
      oldestChargeDate: lots[0]?.date ?? null,
    });
    totalOutstanding += outstanding;
  }

  resultRows.sort((a, b) => b.outstandingInPaisa - a.outstandingInPaisa);

  return {
    asOfDate,
    branchId: params.branchId ?? null,
    controlAccountId: params.controlAccountId,
    rows: resultRows,
    totalOutstandingInPaisa: totalOutstanding,
  };
}

/**
 * Accounts Payable aging — one row per supplier with an outstanding
 * balance against the Accounts Payable control account. `null` if this
 * restaurant has no Accounts Payable account mapped yet (chart of
 * accounts never seeded, or the mapping was deactivated) — never throws,
 * unlike `resolveAccountMappings` (the Phase 4 write-time helper), since
 * this is a read-only report a restaurant can view before ever enabling
 * automatic posting.
 */
export async function getAccountsPayableAging(
  restaurantId: string,
  timezone: string,
  asOfDate?: string,
  branchId?: string,
): Promise<AgingReport | null> {
  const accountId = await resolveControlAccountId(restaurantId, MAPPING_KEYS.ACCOUNTS_PAYABLE);
  if (!accountId) return null;

  const report = await computeAging({
    restaurantId,
    controlAccountId: accountId,
    chargeSide: "credit",
    partyTable: "supplier",
    timezone,
    asOfDate,
    branchId,
  });

  if (report.rows.length === 0) return report;
  const names = await db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.restaurantId, restaurantId));
  const nameById = new Map(names.map((s) => [s.id, s.name]));
  report.rows = report.rows.map((row) => ({ ...row, partyName: nameById.get(row.partyId) ?? "Unknown supplier" }));
  return report;
}

/** The AR mirror of `getAccountsPayableAging`, against Accounts Receivable / customers. */
export async function getAccountsReceivableAging(
  restaurantId: string,
  timezone: string,
  asOfDate?: string,
  branchId?: string,
): Promise<AgingReport | null> {
  const accountId = await resolveControlAccountId(restaurantId, MAPPING_KEYS.ACCOUNTS_RECEIVABLE);
  if (!accountId) return null;

  const report = await computeAging({
    restaurantId,
    controlAccountId: accountId,
    chargeSide: "debit",
    partyTable: "customer",
    timezone,
    asOfDate,
    branchId,
  });

  if (report.rows.length === 0) return report;
  const names = await db
    .select({ id: customers.id, fullName: customers.fullName })
    .from(customers)
    .where(eq(customers.restaurantId, restaurantId));
  const nameById = new Map(names.map((c) => [c.id, c.fullName]));
  report.rows = report.rows.map((row) => ({ ...row, partyName: nameById.get(row.partyId) ?? "Unknown customer" }));
  return report;
}
