import "server-only";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { accountingVoucherLines, accountingVouchers, branches, chartOfAccounts } from "@/db/schema";
import type { AccountingVoucherType } from "./post-voucher";

/**
 * Phase 7, Slice 7c — the accounting audit/journal report: a chronological,
 * printable listing of every posted voucher in a date range, with its full
 * debit/credit lines — what a bookkeeper or auditor actually wants to
 * review ledger activity, as opposed to the RBAC `audit_logs` table (which
 * answers "who changed what in the app," not "what did the books record").
 *
 * Deliberately read-only, no new schema — a pure query over
 * `accounting_vouchers`/`accounting_voucher_lines`, the same tables every
 * other report in this module already reads. Optional `branchId` follows
 * this slice's own Phase 7b precedent (filter the voucher, never the
 * account); optional `voucherType` narrows to one kind of business event
 * (e.g. "show me every purchase this month").
 */

export type JournalVoucherLine = {
  lineId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitInPaisa: number;
  creditInPaisa: number;
  description: string | null;
};

export type JournalVoucherEntry = {
  voucherId: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  status: string;
  branchId: string;
  branchName: string;
  reference: string | null;
  narration: string | null;
  reversalOfVoucherId: string | null;
  totalDebitInPaisa: number;
  totalCreditInPaisa: number;
  lines: JournalVoucherLine[];
};

export type JournalReport = {
  fromDate: string;
  toDate: string;
  branchId: string | null;
  voucherType: string | null;
  vouchers: JournalVoucherEntry[];
  voucherCount: number;
  totalDebitInPaisa: number;
  totalCreditInPaisa: number;
};

export async function getJournalReport(params: {
  restaurantId: string;
  fromDate: string;
  toDate: string;
  branchId?: string;
  voucherType?: AccountingVoucherType;
}): Promise<JournalReport> {
  const voucherRows = await db
    .select({
      id: accountingVouchers.id,
      voucherNumber: accountingVouchers.voucherNumber,
      voucherType: accountingVouchers.voucherType,
      voucherDate: accountingVouchers.voucherDate,
      status: accountingVouchers.status,
      branchId: accountingVouchers.branchId,
      branchName: branches.name,
      reference: accountingVouchers.reference,
      narration: accountingVouchers.narration,
      reversalOfVoucherId: accountingVouchers.reversalOfVoucherId,
      createdAt: accountingVouchers.createdAt,
    })
    .from(accountingVouchers)
    .leftJoin(branches, eq(branches.id, accountingVouchers.branchId))
    .where(
      and(
        eq(accountingVouchers.restaurantId, params.restaurantId),
        gte(accountingVouchers.voucherDate, params.fromDate),
        lte(accountingVouchers.voucherDate, params.toDate),
        params.branchId ? eq(accountingVouchers.branchId, params.branchId) : undefined,
        params.voucherType ? eq(accountingVouchers.voucherType, params.voucherType) : undefined,
      ),
    )
    .orderBy(asc(accountingVouchers.voucherDate), asc(accountingVouchers.createdAt));

  const empty: JournalReport = {
    fromDate: params.fromDate,
    toDate: params.toDate,
    branchId: params.branchId ?? null,
    voucherType: params.voucherType ?? null,
    vouchers: [],
    voucherCount: 0,
    totalDebitInPaisa: 0,
    totalCreditInPaisa: 0,
  };
  if (voucherRows.length === 0) return empty;

  const voucherIds = voucherRows.map((v) => v.id);
  const lineRows = await db
    .select({
      lineId: accountingVoucherLines.id,
      voucherId: accountingVoucherLines.voucherId,
      accountId: accountingVoucherLines.accountId,
      accountCode: chartOfAccounts.code,
      accountName: chartOfAccounts.name,
      debitInPaisa: accountingVoucherLines.debitInPaisa,
      creditInPaisa: accountingVoucherLines.creditInPaisa,
      description: accountingVoucherLines.description,
      createdAt: accountingVoucherLines.createdAt,
    })
    .from(accountingVoucherLines)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, accountingVoucherLines.accountId))
    .where(inArray(accountingVoucherLines.voucherId, voucherIds))
    .orderBy(asc(accountingVoucherLines.createdAt));

  const linesByVoucher = new Map<string, JournalVoucherLine[]>();
  for (const row of lineRows) {
    const list = linesByVoucher.get(row.voucherId) ?? [];
    list.push({
      lineId: row.lineId,
      accountId: row.accountId,
      accountCode: row.accountCode,
      accountName: row.accountName,
      debitInPaisa: row.debitInPaisa,
      creditInPaisa: row.creditInPaisa,
      description: row.description,
    });
    linesByVoucher.set(row.voucherId, list);
  }

  let totalDebitInPaisa = 0;
  let totalCreditInPaisa = 0;

  const vouchers: JournalVoucherEntry[] = voucherRows.map((v) => {
    const lines = linesByVoucher.get(v.id) ?? [];
    const voucherDebit = lines.reduce((s, l) => s + l.debitInPaisa, 0);
    const voucherCredit = lines.reduce((s, l) => s + l.creditInPaisa, 0);
    totalDebitInPaisa += voucherDebit;
    totalCreditInPaisa += voucherCredit;
    return {
      voucherId: v.id,
      voucherNumber: v.voucherNumber,
      voucherType: v.voucherType,
      voucherDate: v.voucherDate,
      status: v.status,
      branchId: v.branchId,
      branchName: v.branchName ?? "—",
      reference: v.reference,
      narration: v.narration,
      reversalOfVoucherId: v.reversalOfVoucherId,
      totalDebitInPaisa: voucherDebit,
      totalCreditInPaisa: voucherCredit,
      lines,
    };
  });

  return {
    fromDate: params.fromDate,
    toDate: params.toDate,
    branchId: params.branchId ?? null,
    voucherType: params.voucherType ?? null,
    vouchers,
    voucherCount: vouchers.length,
    totalDebitInPaisa,
    totalCreditInPaisa,
  };
}
