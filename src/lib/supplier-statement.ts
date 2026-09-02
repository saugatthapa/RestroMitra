import "server-only";
import { and, eq, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { ledgerEntries, suppliers } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { restaurantDate } from "@/lib/restaurant-date";

export class SupplierStatementError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

export type SupplierStatementLineType = "purchase" | "payment" | "adjustment";

export type SupplierStatementLine = {
  id: string;
  type: SupplierStatementLineType;
  entryDate: string;
  createdAt: Date;
  description: string;
  note: string | null;
  referenceId: string | null;
  /**
   * Signed effect on the balance this restaurant owes the supplier:
   * positive increases what's owed (a purchase, a debit adjustment),
   * negative decreases it (a payment, a credit adjustment).
   */
  deltaInPaisa: number;
  /** Running balance owed to the supplier immediately AFTER this line. */
  runningBalanceInPaisa: number;
};

export type SupplierStatement = {
  supplierId: string;
  supplierName: string;
  from: string | null;
  to: string;
  openingBalanceInPaisa: number;
  closingBalanceInPaisa: number;
  totalPurchasesInPaisa: number;
  totalPaymentsInPaisa: number;
  totalAdjustmentsInPaisa: number;
  lines: SupplierStatementLine[];
};

/**
 * A running-ledger supplier statement (Gap Audit P1): opening balance +
 * purchases − payments ± adjustments = closing balance, exactly the shape
 * a real supplier relationship needs, as opposed to getSupplierDueReport's
 * point-in-time "what's outstanding right now" snapshot (supplier-dues.ts).
 *
 * Sourced entirely from ledger_entries rows linked to this supplier via
 * supplierId (see that column's own comment in schema.ts) — no second
 * ledger, no duplicated bookkeeping:
 *
 *  - "purchase" lines: category="purchase" entries with dueStatus !=
 *    "none". A purchase's ledger entry is created for EVERY purchase, cash
 *    or credit (see recordPurchaseLedgerEntry) — cash purchases keep
 *    dueStatus "none" forever (they're paid in full at the register and
 *    never handed to settleLedgerDue), while credit purchases start
 *    "outstanding" and may later become "settled". Filtering out "none"
 *    is what keeps a cash purchase (which was never actually a balance
 *    owed to the supplier) out of this AP-style ledger, and is exactly
 *    the same "was this ever a credit purchase" signal
 *    getSupplierDueReport gets from joining purchases.isCredit — see the
 *    reconciliation note below.
 *  - "payment" lines: category="due_settlement" entries — always a
 *    realization of a "purchase" line above (settleLedgerDue never
 *    creates one for a cash purchase, since a cash purchase's entry never
 *    reaches dueStatus "outstanding" in the first place).
 *  - "adjustment" lines: category="other" with referenceType
 *    "supplier_adjustment" — manual credit/debit notes recorded via
 *    recordSupplierAdjustment (ledger.ts).
 *
 * Reconciliation: for a statement run with `to` = today and `from`
 * unset (opening balance 0, everything in range), closingBalanceInPaisa
 * MUST equal getSupplierDueReport's outstandingInPaisa for this same
 * supplier as of now, PROVIDED no adjustments exist (due-report has no
 * adjustment concept to agree with). That equality holds because both are
 * the same sum decomposed two different ways:
 *
 *   due-report: Σ (purchase.amountInPaisa − purchase.settledAmountInPaisa)   over outstanding credit purchases
 *   statement:  Σ purchase.amountInPaisa (all ever-credit purchases) − Σ settlement.amountInPaisa (their payments)
 *
 * A fully-settled purchase contributes 0 to both (due-report excludes it
 * outright via dueStatus="outstanding"; here its purchase delta and the
 * sum of its payment deltas cancel to 0), so the two sums are identical.
 * See the reconciliation test in supplier-statement.test.ts for the
 * numeric proof.
 */
export async function getSupplierStatement(
  restaurantId: string,
  supplierId: string,
  timezone: string,
  range: { from?: string; to?: string } = {},
): Promise<SupplierStatement> {
  const [supplier] = await db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.restaurantId, restaurantId)))
    .limit(1);
  if (!supplier) {
    throw new SupplierStatementError("Supplier not found.", 404);
  }

  const to = range.to ?? restaurantDate(timezone);
  const from = range.from ?? null;

  const [purchaseRows, paymentRows, adjustmentRows] = await Promise.all([
    db
      .select({
        id: ledgerEntries.id,
        entryDate: ledgerEntries.entryDate,
        createdAt: ledgerEntries.createdAt,
        description: ledgerEntries.description,
        note: ledgerEntries.note,
        referenceId: ledgerEntries.referenceId,
        amountInPaisa: ledgerEntries.amountInPaisa,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.restaurantId, restaurantId),
          eq(ledgerEntries.supplierId, supplierId),
          eq(ledgerEntries.category, "purchase"),
          eq(ledgerEntries.isVoided, false),
          // Excludes cash purchases — see this function's own doc comment.
          // A cash purchase's ledger entry is created with dueStatus
          // "none" and stays there forever (never handed to
          // settleLedgerDue), while every ever-credit purchase starts
          // "outstanding" and may become "settled" — never "none".
          ne(ledgerEntries.dueStatus, "none"),
          lte(ledgerEntries.entryDate, to),
        ),
      ),
    db
      .select({
        id: ledgerEntries.id,
        entryDate: ledgerEntries.entryDate,
        createdAt: ledgerEntries.createdAt,
        description: ledgerEntries.description,
        note: ledgerEntries.note,
        referenceId: ledgerEntries.referenceId,
        amountInPaisa: ledgerEntries.amountInPaisa,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.restaurantId, restaurantId),
          eq(ledgerEntries.supplierId, supplierId),
          eq(ledgerEntries.category, "due_settlement"),
          eq(ledgerEntries.isVoided, false),
          lte(ledgerEntries.entryDate, to),
        ),
      ),
    db
      .select({
        id: ledgerEntries.id,
        entryDate: ledgerEntries.entryDate,
        createdAt: ledgerEntries.createdAt,
        description: ledgerEntries.description,
        note: ledgerEntries.note,
        referenceId: ledgerEntries.referenceId,
        amountInPaisa: ledgerEntries.amountInPaisa,
        direction: ledgerEntries.direction,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.restaurantId, restaurantId),
          eq(ledgerEntries.supplierId, supplierId),
          eq(ledgerEntries.category, "other"),
          eq(ledgerEntries.referenceType, "supplier_adjustment"),
          eq(ledgerEntries.isVoided, false),
          lte(ledgerEntries.entryDate, to),
        ),
      ),
  ]);

  type RawLine = {
    id: string;
    entryDate: string;
    createdAt: Date;
    description: string;
    note: string | null;
    referenceId: string | null;
    type: SupplierStatementLineType;
    deltaInPaisa: number;
  };

  const rawLines: RawLine[] = [
    ...purchaseRows.map((r) => ({
      id: r.id,
      entryDate: r.entryDate,
      createdAt: r.createdAt,
      description: r.description,
      note: r.note,
      referenceId: r.referenceId,
      type: "purchase" as const,
      deltaInPaisa: r.amountInPaisa,
    })),
    ...paymentRows.map((r) => ({
      id: r.id,
      entryDate: r.entryDate,
      createdAt: r.createdAt,
      description: r.description,
      note: r.note,
      referenceId: r.referenceId,
      type: "payment" as const,
      deltaInPaisa: -r.amountInPaisa,
    })),
    ...adjustmentRows.map((r) => ({
      id: r.id,
      entryDate: r.entryDate,
      createdAt: r.createdAt,
      description: r.description,
      note: r.note,
      referenceId: r.referenceId,
      type: "adjustment" as const,
      deltaInPaisa: r.direction === "debit" ? r.amountInPaisa : -r.amountInPaisa,
    })),
  ].sort((a, b) => {
    if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const beforeRange = from ? rawLines.filter((l) => l.entryDate < from) : [];
  const inRange = from ? rawLines.filter((l) => l.entryDate >= from) : rawLines;

  const openingBalanceInPaisa = beforeRange.reduce((sum, l) => sum + l.deltaInPaisa, 0);

  let runningBalanceInPaisa = openingBalanceInPaisa;
  const lines: SupplierStatementLine[] = inRange.map((l) => {
    runningBalanceInPaisa += l.deltaInPaisa;
    return {
      id: l.id,
      type: l.type,
      entryDate: l.entryDate,
      createdAt: l.createdAt,
      description: l.description,
      note: l.note,
      referenceId: l.referenceId,
      deltaInPaisa: l.deltaInPaisa,
      runningBalanceInPaisa,
    };
  });

  const totalPurchasesInPaisa = inRange.filter((l) => l.type === "purchase").reduce((s, l) => s + l.deltaInPaisa, 0);
  const totalPaymentsInPaisa = inRange
    .filter((l) => l.type === "payment")
    .reduce((s, l) => s + Math.abs(l.deltaInPaisa), 0);
  const totalAdjustmentsInPaisa = inRange
    .filter((l) => l.type === "adjustment")
    .reduce((s, l) => s + l.deltaInPaisa, 0);

  return {
    supplierId: supplier.id,
    supplierName: supplier.name,
    from,
    to,
    openingBalanceInPaisa,
    closingBalanceInPaisa: runningBalanceInPaisa,
    totalPurchasesInPaisa,
    totalPaymentsInPaisa,
    totalAdjustmentsInPaisa,
    lines,
  };
}
