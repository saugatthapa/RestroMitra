import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { accountingVoucherLines, accountingVouchers, chartOfAccounts } from "@/db/schema";

/**
 * Phase 6, Slice 6c — VAT return / tax summary report. Reads only existing
 * voucher/account data (no new schema of its own), the same "just read the
 * ledger" approach Slice 5c's Cash Flow Statement already established:
 * output tax and input tax are each the NET movement (not the running
 * balance) of one seeded account over the requested period — a real VAT
 * return is period-based ("what did I collect/pay THIS month"), not a
 * point-in-time balance snapshot.
 *
 * Explicitly a summary for the owner's/accountant's own reference (per
 * ACCOUNTING_PHASE_6_PLAN.md Part 3's own framing) — never a claim of being
 * a filable/submittable IRD form, and never an assertion that this
 * restaurant's configured `taxRateBasisPoints` actually IS VAT (it's
 * whatever tax rate the restaurant itself configured; this report labels it
 * "Output VAT" because 2100 is the account Slice 6a's Input VAT (1150) is
 * designed to net against, matching the Phase 6 plan's own VAT-focused
 * scope — see that plan's Part 0 caveats).
 *
 * KNOWN LIMITATION, inherited from Phase 4 and NOT fixed by this slice: a
 * sales refund (`postRefundVoucher`, integrations/payment-settlement.ts)
 * books its full amount to "4910 Sales Returns & Refunds" only — it never
 * reduces "2100 Tax Payable," a documented Phase 4 simplification (the
 * payments/refund schema has no field recording how much of a refund was
 * ever tax). So this report's Output VAT figure does NOT subtract tax on
 * refunded sales; a restaurant with meaningful refund volume will see this
 * report overstate its true net Output VAT for the period. Flagged here
 * rather than silently accepted, since a VAT-focused report is exactly
 * where that gap matters most — fixing it would mean reworking Phase 4's
 * own refund posting, out of scope for this slice.
 */

const OUTPUT_VAT_ACCOUNT_CODE = "2100"; // Tax Payable — credited by postSaleAndCogsVouchers whenever a sale's own taxInPaisa > 0.
const INPUT_VAT_ACCOUNT_CODE = "1150"; // Input VAT Receivable — Slice 6a's own new account.

export type VatReturnStatement = {
  fromDate: string;
  toDate: string;
  /** Net credits to "2100 Tax Payable" in the period — VAT collected on sales. */
  outputVatInPaisa: number;
  /** Net debits to "1150 Input VAT Receivable" in the period — VAT paid on purchases. */
  inputVatInPaisa: number;
  /** outputVat - inputVat. Positive = owed to the IRD for this period; negative = a net refundable/creditable position. */
  netPayableInPaisa: number;
};

async function resolveAccountId(restaurantId: string, code: string): Promise<string | null> {
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.restaurantId, restaurantId), eq(chartOfAccounts.code, code)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Net movement of one account over the period, signed so a positive result
 * always means "more of this account's own normal-balance side" — credit
 * for a liability (Output VAT growing), debit for an asset (Input VAT
 * growing). Deliberately no `status` filter on the voucher join, same as
 * Slice 5c's own cash-flow query: `reverseVoucher()` never edits an
 * original voucher's own lines, it posts a SEPARATE voucher with every line
 * swapped — so a reversed purchase/sale's original lines and its reversal's
 * swapped lines are both included here and net to exactly zero on their
 * own, with no special-casing needed.
 */
async function netMovementInPaisa(
  restaurantId: string,
  accountId: string | null,
  fromDate: string,
  toDate: string,
  normalBalanceSide: "credit" | "debit",
): Promise<number> {
  if (!accountId) return 0;
  const rows = await db
    .select({ debitInPaisa: accountingVoucherLines.debitInPaisa, creditInPaisa: accountingVoucherLines.creditInPaisa })
    .from(accountingVoucherLines)
    .innerJoin(accountingVouchers, eq(accountingVouchers.id, accountingVoucherLines.voucherId))
    .where(
      and(
        eq(accountingVouchers.restaurantId, restaurantId),
        eq(accountingVoucherLines.accountId, accountId),
        gte(accountingVouchers.voucherDate, fromDate),
        lte(accountingVouchers.voucherDate, toDate),
      ),
    );
  const totalDebitInPaisa = rows.reduce((s, r) => s + r.debitInPaisa, 0);
  const totalCreditInPaisa = rows.reduce((s, r) => s + r.creditInPaisa, 0);
  return normalBalanceSide === "credit" ? totalCreditInPaisa - totalDebitInPaisa : totalDebitInPaisa - totalCreditInPaisa;
}

export async function getVatReturnStatement(params: {
  restaurantId: string;
  fromDate: string;
  toDate: string;
}): Promise<VatReturnStatement> {
  const { restaurantId, fromDate, toDate } = params;

  const [outputVatAccountId, inputVatAccountId] = await Promise.all([
    resolveAccountId(restaurantId, OUTPUT_VAT_ACCOUNT_CODE),
    resolveAccountId(restaurantId, INPUT_VAT_ACCOUNT_CODE),
  ]);

  const [outputVatInPaisa, inputVatInPaisa] = await Promise.all([
    netMovementInPaisa(restaurantId, outputVatAccountId, fromDate, toDate, "credit"),
    netMovementInPaisa(restaurantId, inputVatAccountId, fromDate, toDate, "debit"),
  ]);

  return {
    fromDate,
    toDate,
    outputVatInPaisa,
    inputVatInPaisa,
    netPayableInPaisa: outputVatInPaisa - inputVatInPaisa,
  };
}
