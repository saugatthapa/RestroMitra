import "server-only";
import { getJournalReport, type JournalVoucherEntry } from "./journal-report";
import { paisaToRupees } from "@/lib/money";
import type { AccountingVoucherType } from "./post-voucher";

/**
 * Phase 7, Slice 7f — Tally-compatible export.
 *
 * ⚠️ UNVERIFIED AGAINST REAL TALLY SOFTWARE. Per
 * ACCOUNTING_PHASE_7_PLAN.md §1.5/§2.6: there is no licensed Tally install
 * reachable in this environment to actually test an import against. Every
 * structural and sign-convention decision below is copied verbatim from
 * Tally's own public Developer Reference ("Case Study 1 — XML Request and
 * Response Formats", help.tallysolutions.com), specifically its own
 * worked, balanced example (a Payment voucher debiting Conveyance 12000
 * and crediting Bank of India 12000) — not assumed from general knowledge,
 * and not taken from a secondary/third-party write-up (several of those
 * disagree with each other and with Tally's own example on the AMOUNT
 * sign). But "reads correctly against the documentation" is not the same
 * as "a real Tally import accepts it." Treat this as a starting point to
 * test against a disposable Tally company with a small date range first,
 * never as a verified migration path — see the permanent caveat this
 * module's consumers (the API route, the UI) are required to keep
 * attached to this feature.
 *
 * Sign convention, confirmed from that exact worked example:
 *   Debit  → <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>, AMOUNT is NEGATIVE.
 *   Credit → <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>,  AMOUNT is POSITIVE.
 * (Tally's AMOUNT sign is the opposite of what a spreadsheet would
 * naturally assign a debit — this is a well-known point of confusion in
 * Tally XML integrations, which is exactly why this comment quotes the
 * source example directly rather than paraphrasing it.)
 *
 * Reuses Slice 7c's `getJournalReport` rather than a fourth parallel
 * voucher/line query — this export can never disagree with what the
 * Journal report itself already shows for the same period. Same "layer a
 * transformation over an existing generator" pattern Slice 7d's Inventory
 * Valuation used over Slice 7a's Cash Book.
 *
 * Known, documented limitations (also surfaced in the UI, not just here):
 *   - Ledger names must match an existing Tally ledger by exact string —
 *     Tally's XML import does not create missing ledgers unless the
 *     target company has "Allow unknown ledgers in import" enabled, and
 *     this export has no way to know that setting from here.
 *   - This schema's Accounts Receivable/Payable are single shared control
 *     accounts with a customer/supplier sub-ledger TAG on each line (see
 *     aging.ts's own comment) — Tally's own convention is one ledger per
 *     debtor/creditor. This export does not attempt to synthesize
 *     per-party Tally ledgers; every AR/AP line lands under one generic
 *     "Accounts Receivable"/"Accounts Payable" ledger in Tally, which
 *     loses Tally-side per-party drill-down (the party is still
 *     traceable back in this app's own AR/AP Aging report).
 *   - `opening_balance` vouchers export as ordinary Journal vouchers.
 *     Tally's own convention is to set a ledger's opening balance as a
 *     field on the ledger MASTER, not a voucher — this export doesn't
 *     attempt a Masters-type import, only Vouchers, so this is the
 *     pragmatic (if slightly non-idiomatic) choice.
 *   - `payroll` exports as a plain Journal voucher, not through Tally's
 *     own separate Payroll feature (employee/pay-head masters) — that is
 *     a materially different, unrelated XML schema this slice does not
 *     attempt.
 */

const VOUCHER_TYPE_TO_TALLY: Record<AccountingVoucherType, string> = {
  sales: "Sales",
  purchase: "Purchase",
  payment: "Payment",
  expense: "Payment",
  // See integrations/payment-settlement.ts's own narration ("credit
  // note — reduces output VAT") for why this app's "refund" is a credit
  // note, not a payment, in Tally's own vocabulary.
  refund: "Credit Note",
  contra: "Contra",
  journal: "Journal",
  payroll: "Journal",
  opening_balance: "Journal",
  fixed_asset: "Journal",
  depreciation: "Journal",
  loan: "Journal",
};

function tallyVoucherTypeName(voucherType: string): string {
  return VOUCHER_TYPE_TO_TALLY[voucherType as AccountingVoucherType] ?? "Journal";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** "2026-05-05" -> "20260505" — Tally's own DATE field format. */
function toTallyDate(voucherDate: string): string {
  return voucherDate.replaceAll("-", "");
}

/**
 * `null` (and the voucher is skipped, not silently mis-exported) if its
 * own lines don't actually balance, or it isn't a real posted/reversed
 * transaction. `postVoucher()` should make an unbalanced voucher
 * structurally impossible (see Slice 7e's own Health Check, which is the
 * right place to investigate one if it's ever found) — this is a defensive
 * floor so this export can never hand Tally something it would reject
 * anyway, and every skip is reported back by voucher number so nothing
 * silently disappears from the count.
 */
function buildVoucherXml(voucher: JournalVoucherEntry, includeBranchName: boolean): string | null {
  if (voucher.status !== "posted" && voucher.status !== "reversed") return null;

  const lines = voucher.lines.filter((l) => l.debitInPaisa > 0 || l.creditInPaisa > 0);
  const totalDebitInPaisa = lines.reduce((s, l) => s + l.debitInPaisa, 0);
  const totalCreditInPaisa = lines.reduce((s, l) => s + l.creditInPaisa, 0);
  if (lines.length === 0 || totalDebitInPaisa !== totalCreditInPaisa) return null;

  const narrationParts = [
    voucher.narration,
    voucher.reference ? `Ref: ${voucher.reference}` : null,
    includeBranchName ? `Branch: ${voucher.branchName}` : null,
  ].filter((p): p is string => Boolean(p));

  const entriesXml = lines
    .map((l) => {
      const isDebit = l.debitInPaisa > 0;
      const amountInRupees = isDebit ? -paisaToRupees(l.debitInPaisa) : paisaToRupees(l.creditInPaisa);
      return (
        "<ALLLEDGERENTRIES.LIST>" +
        `<LEDGERNAME>${escapeXml(l.accountName)}</LEDGERNAME>` +
        `<ISDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>` +
        `<AMOUNT>${amountInRupees.toFixed(2)}</AMOUNT>` +
        "</ALLLEDGERENTRIES.LIST>"
      );
    })
    .join("");

  return (
    "<VOUCHER>" +
    `<DATE>${toTallyDate(voucher.voucherDate)}</DATE>` +
    (narrationParts.length > 0 ? `<NARRATION>${escapeXml(narrationParts.join(" — "))}</NARRATION>` : "") +
    `<VOUCHERTYPENAME>${tallyVoucherTypeName(voucher.voucherType)}</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${escapeXml(voucher.voucherNumber)}</VOUCHERNUMBER>` +
    entriesXml +
    "</VOUCHER>"
  );
}

export type TallyExportResult = {
  xml: string;
  fromDate: string;
  toDate: string;
  voucherCount: number;
  /** Voucher numbers omitted from the export (see buildVoucherXml's own comment) — always expected to be empty in normal operation. */
  skippedVoucherNumbers: string[];
};

export async function getTallyExport(params: {
  restaurantId: string;
  fromDate: string;
  toDate: string;
  branchId?: string;
}): Promise<TallyExportResult> {
  const report = await getJournalReport(params);

  // Only worth naming the branch in NARRATION when the export actually
  // spans more than one — a single-branch export (or one already narrowed
  // by `branchId`) never needs it, same "don't show what isn't
  // informative" posture as BranchScopeNote elsewhere in this module.
  const distinctBranchNames = new Set(report.vouchers.map((v) => v.branchName));
  const includeBranchName = distinctBranchNames.size > 1;

  const voucherXmls: string[] = [];
  const skippedVoucherNumbers: string[] = [];
  for (const voucher of report.vouchers) {
    const xml = buildVoucherXml(voucher, includeBranchName);
    if (xml) voucherXmls.push(xml);
    else skippedVoucherNumbers.push(voucher.voucherNumber);
  }

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<ENVELOPE>" +
    "<HEADER>" +
    "<VERSION>1</VERSION>" +
    "<TALLYREQUEST>Import</TALLYREQUEST>" +
    "<TYPE>Data</TYPE>" +
    "<ID>Vouchers</ID>" +
    "</HEADER>" +
    "<BODY>" +
    "<DESC></DESC>" +
    "<DATA>" +
    "<TALLYMESSAGE>" +
    voucherXmls.join("") +
    "</TALLYMESSAGE>" +
    "</DATA>" +
    "</BODY>" +
    "</ENVELOPE>";

  return {
    xml,
    fromDate: report.fromDate,
    toDate: report.toDate,
    voucherCount: voucherXmls.length,
    skippedVoucherNumbers,
  };
}
