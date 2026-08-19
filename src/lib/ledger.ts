import "server-only";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "@/db";
import { ledgerEntries } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import type { LedgerCategory, LedgerDirection } from "@/lib/ledger-categories";

export class LedgerError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The single low-level insert every other function in this file goes
 * through — same "one choke point" shape as recordLoyaltyTransaction
 * (loyalty.ts) / recordStockMovement (inventory.ts). amountInPaisa is
 * always positive here; direction carries the sign (see the comment block
 * above ledgerEntries in schema.ts).
 */
export async function recordLedgerEntry(
  tx: Transaction,
  params: {
    restaurantId: string;
    direction: LedgerDirection;
    category: LedgerCategory;
    amountInPaisa: number;
    entryDate?: string;
    counterpartyName?: string | null;
    description: string;
    note?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    markAsDue?: boolean;
    recordedByUserId?: string | null;
  },
) {
  if (!Number.isInteger(params.amountInPaisa) || params.amountInPaisa <= 0) {
    throw new LedgerError("A ledger entry must have a positive whole-paisa amount.");
  }

  const [entry] = await tx
    .insert(ledgerEntries)
    .values({
      restaurantId: params.restaurantId,
      entryDate: params.entryDate ?? todayIsoUtc(),
      direction: params.direction,
      category: params.category,
      amountInPaisa: params.amountInPaisa,
      counterpartyName: params.counterpartyName || null,
      description: params.description,
      note: params.note || null,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      dueStatus: params.markAsDue ? "outstanding" : "none",
      recordedByUserId: params.recordedByUserId ?? null,
    })
    .returning();

  return entry;
}

/**
 * Called once per order, from the same "pending/confirmed/... -> completed"
 * transaction that awards loyalty points (see recordOrderCompletionLoyalty
 * in loyalty.ts) — completion is this app's one existing definition of
 * "this sale is real" (Reports uses the same moment). Idempotent for the
 * same reason: the order-status state machine never re-enters "completed".
 *
 * paymentStatus is the order's own already-maintained cached field (kept
 * in sync by the payments/adjustments/refunds routes) — reusing it here
 * instead of re-summing the payments ledger keeps this hook a single cheap
 * insert. A "partially_paid" order still books its FULL total as an
 * outstanding due, not just the unpaid remainder — a deliberate MVP
 * simplification (documented on the ledgerEntries table itself) rather
 * than splitting one order into a paid entry + a due entry.
 */
export async function recordSalesLedgerEntry(
  tx: Transaction,
  params: {
    restaurantId: string;
    orderId: string;
    orderNumber: string;
    totalInPaisa: number;
    paymentStatus: "unpaid" | "partially_paid" | "paid";
    customerName?: string | null;
    entryDate?: string;
    recordedByUserId?: string | null;
  },
) {
  if (params.totalInPaisa <= 0) return null; // a free/zero-total order books nothing

  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "credit",
    category: "sales",
    amountInPaisa: params.totalInPaisa,
    entryDate: params.entryDate,
    counterpartyName: params.customerName ?? null,
    description: `Order #${params.orderNumber}`,
    referenceType: "order",
    referenceId: params.orderId,
    markAsDue: params.paymentStatus !== "paid",
    recordedByUserId: params.recordedByUserId ?? null,
  });
}

/** Called from the expense-creation route, right after inserting the expenses row. */
export async function recordExpenseLedgerEntry(
  tx: Transaction,
  params: {
    restaurantId: string;
    expenseId: string;
    amountInPaisa: number;
    categoryLabel: string;
    description: string;
    expenseDate: string;
    recordedByUserId?: string | null;
  },
) {
  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "debit",
    category: "expense",
    amountInPaisa: params.amountInPaisa,
    entryDate: params.expenseDate,
    description: `${params.categoryLabel}: ${params.description}`,
    referenceType: "expense",
    referenceId: params.expenseId,
    recordedByUserId: params.recordedByUserId ?? null,
  });
}

/**
 * Reverses a previously-recorded expense debit — called when a PAID
 * expense is voided (see the expense PATCH route). Inserts a new CREDIT
 * entry linked back to the original via referenceId, rather than
 * mutating or deleting the original debit — the financial history stays
 * intact and traceable (spec section 39: reversals, not silent edits).
 * The inverse (recordExpenseLedgerEntry again) is used when a voided
 * expense is un-voided.
 */
export async function reverseExpenseLedgerEntry(
  tx: Transaction,
  params: {
    restaurantId: string;
    expenseId: string;
    amountInPaisa: number;
    categoryLabel: string;
    description: string;
    recordedByUserId?: string | null;
  },
) {
  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "credit",
    category: "expense",
    amountInPaisa: params.amountInPaisa,
    description: `Voided: ${params.categoryLabel}: ${params.description}`,
    referenceType: "expense",
    referenceId: params.expenseId,
    recordedByUserId: params.recordedByUserId ?? null,
  });
}

/** Called from the purchase-creation route, right after the purchase transaction commits its header row. */
export async function recordPurchaseLedgerEntry(
  tx: Transaction,
  params: {
    restaurantId: string;
    purchaseId: string;
    totalInPaisa: number;
    supplierName?: string | null;
    invoiceNumber?: string | null;
    recordedByUserId?: string | null;
  },
) {
  if (params.totalInPaisa <= 0) return null;

  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "debit",
    category: "purchase",
    amountInPaisa: params.totalInPaisa,
    counterpartyName: params.supplierName ?? null,
    description: params.invoiceNumber ? `Purchase (invoice ${params.invoiceNumber})` : "Purchase",
    referenceType: "purchase",
    referenceId: params.purchaseId,
    recordedByUserId: params.recordedByUserId ?? null,
  });
}

/**
 * Settles all or part of an outstanding due: inserts a new realized entry
 * (same direction/counterparty as the original, category "due_settlement",
 * linked back via referenceId) and advances the original's
 * settledAmountInPaisa. Supports partial settlement — a customer paying
 * off half their tab today still leaves the rest outstanding for next
 * time — flipping dueStatus to "settled" only once the running total
 * reaches the original amount.
 *
 * The original row's UPDATE is a compare-and-swap on dueStatus =
 * 'outstanding' (same pattern as the order-status route's own
 * compare-and-swap on orders.status) so two concurrent settle requests on
 * the same entry can't both succeed past the original's remaining balance.
 */
export async function settleLedgerDue(
  tx: Transaction,
  params: {
    restaurantId: string;
    entryId: string;
    amountInPaisa: number;
    note?: string | null;
    recordedByUserId?: string | null;
  },
) {
  if (!Number.isInteger(params.amountInPaisa) || params.amountInPaisa <= 0) {
    throw new LedgerError("Settlement amount must be a positive whole-paisa amount.");
  }

  const [original] = await tx
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.id, params.entryId), eq(ledgerEntries.restaurantId, params.restaurantId)))
    .limit(1);

  if (!original) {
    throw new LedgerError("Ledger entry not found.", 404);
  }
  if (original.dueStatus !== "outstanding") {
    throw new LedgerError("This entry has no outstanding balance to settle.");
  }

  const remainingInPaisa = original.amountInPaisa - original.settledAmountInPaisa;
  if (params.amountInPaisa > remainingInPaisa) {
    throw new LedgerError(
      `Settlement amount exceeds the remaining balance (${remainingInPaisa} paisa left).`,
    );
  }

  const newSettledAmount = original.settledAmountInPaisa + params.amountInPaisa;
  const nowFullySettled = newSettledAmount >= original.amountInPaisa;

  const [updated] = await tx
    .update(ledgerEntries)
    .set({
      settledAmountInPaisa: newSettledAmount,
      dueStatus: nowFullySettled ? "settled" : "outstanding",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ledgerEntries.id, params.entryId),
        eq(ledgerEntries.restaurantId, params.restaurantId),
        eq(ledgerEntries.dueStatus, "outstanding"),
      ),
    )
    .returning();

  if (!updated) {
    // Another concurrent settlement already moved this row past
    // "outstanding" between our read and this write — reject cleanly
    // rather than double-booking a settlement entry for money that was
    // already accounted for.
    throw new LedgerError("This entry was just settled by someone else. Please refresh and try again.", 409);
  }

  const settlementEntry = await recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: original.direction,
    category: "due_settlement",
    amountInPaisa: params.amountInPaisa,
    counterpartyName: original.counterpartyName,
    description: `Due settled: ${original.description}`,
    note: params.note ?? null,
    referenceType: "due_settlement",
    referenceId: original.id,
    recordedByUserId: params.recordedByUserId ?? null,
  });

  return { original: updated, settlementEntry };
}
