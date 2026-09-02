import "server-only";
import { and, asc, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import { ledgerEntries } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import type { LedgerCategory, LedgerDirection, LedgerDueStatus } from "@/lib/ledger-categories";
import { restaurantDate } from "@/lib/restaurant-date";

export class LedgerError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

export type LedgerEntryFilters = {
  from?: string;
  to?: string;
  category?: LedgerCategory;
  direction?: LedgerDirection;
  dueStatus?: LedgerDueStatus;
  includeVoided?: boolean;
  // Commercial Launch Phase B.5 — Customer Credit. Narrows to entries
  // linked to one CRM customer (see the customerId column comment in
  // schema.ts) — used by the customer detail route's credit history and by
  // getCustomerOutstandingBalance/settleCustomerCredit below.
  customerId?: string;
};

/**
 * Lists ledger entries for a restaurant, filtered/ordered exactly the way
 * GET /api/restaurants/[slug]/ledger does — this function IS that route's
 * query, extracted so the Data Export route (Commercial Launch Phase B.5)
 * can reuse the identical filter logic at a higher row limit rather than
 * duplicating it. `limit` defaults to 500 so the existing route's behavior
 * is unchanged by this refactor.
 */
export async function listLedgerEntries(
  restaurantId: string,
  filters: LedgerEntryFilters = {},
  limit = 500,
) {
  return db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.restaurantId, restaurantId),
        filters.includeVoided ? undefined : eq(ledgerEntries.isVoided, false),
        filters.category ? eq(ledgerEntries.category, filters.category) : undefined,
        filters.direction ? eq(ledgerEntries.direction, filters.direction) : undefined,
        filters.dueStatus ? eq(ledgerEntries.dueStatus, filters.dueStatus) : undefined,
        filters.from ? gte(ledgerEntries.entryDate, filters.from) : undefined,
        filters.to ? lte(ledgerEntries.entryDate, filters.to) : undefined,
        filters.customerId ? eq(ledgerEntries.customerId, filters.customerId) : undefined,
      ),
    )
    .orderBy(desc(ledgerEntries.entryDate), desc(ledgerEntries.createdAt))
    .limit(limit);
}

/**
 * The single low-level insert every other function in this file goes
 * through — same "one choke point" shape as recordLoyaltyTransaction
 * (loyalty.ts) / recordStockMovement (inventory.ts). amountInPaisa is
 * always positive here; direction carries the sign (see the comment block
 * above ledgerEntries in schema.ts).
 *
 * `timezone` is the RESTAURANT's own timezone — used only as the fallback
 * for `entryDate` when a caller doesn't supply one explicitly (e.g. "today"
 * for a reversal or a purchase). Required on every call, even when
 * `entryDate` is always supplied by that particular caller, so this
 * function's signature can't silently drift back to the server's own UTC
 * clock — see restaurant-date.ts's doc comment for why that clock is wrong
 * for "what day is it for this restaurant."
 */
export async function recordLedgerEntry(
  tx: Transaction,
  params: {
    restaurantId: string;
    direction: LedgerDirection;
    category: LedgerCategory;
    amountInPaisa: number;
    entryDate?: string;
    timezone: string;
    counterpartyName?: string | null;
    description: string;
    note?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    markAsDue?: boolean;
    recordedByUserId?: string | null;
    // Commercial Launch Phase B.5 — Customer Credit. Optional link to a
    // CRM customer (see the column's own comment in schema.ts) — the
    // caller is responsible for having already verified this customer
    // belongs to `restaurantId` (see the ledger route's/credit route's own
    // lookups), same trust boundary as every other id this function
    // accepts without re-checking tenancy itself.
    customerId?: string | null;
    // Supplier Statement (Gap Audit P1). Same trust boundary/shape as
    // customerId above, mirrored for suppliers — see the supplierId
    // column's own comment in schema.ts.
    supplierId?: string | null;
  },
) {
  if (!Number.isInteger(params.amountInPaisa) || params.amountInPaisa <= 0) {
    throw new LedgerError("A ledger entry must have a positive whole-paisa amount.");
  }

  const [entry] = await tx
    .insert(ledgerEntries)
    .values({
      restaurantId: params.restaurantId,
      entryDate: params.entryDate ?? restaurantDate(params.timezone),
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
      customerId: params.customerId ?? null,
      supplierId: params.supplierId ?? null,
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
    timezone: string;
    recordedByUserId?: string | null;
    // Commercial Launch Phase B.5 — Customer Credit. When the order is
    // linked to a CRM customer, this links the resulting ledger entry too
    // — so an order finishing unpaid/partially paid automatically becomes
    // part of that customer's own credit/tab (see getCustomerOutstandingBalance/
    // settleCustomerCredit) with zero extra staff action, the same way it
    // already becomes part of Account Books' restaurant-wide due tracking.
    customerId?: string | null;
  },
) {
  if (params.totalInPaisa <= 0) return null; // a free/zero-total order books nothing

  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "credit",
    category: "sales",
    amountInPaisa: params.totalInPaisa,
    entryDate: params.entryDate,
    timezone: params.timezone,
    counterpartyName: params.customerName ?? null,
    description: `Order #${params.orderNumber}`,
    referenceType: "order",
    referenceId: params.orderId,
    markAsDue: params.paymentStatus !== "paid",
    recordedByUserId: params.recordedByUserId ?? null,
    customerId: params.customerId ?? null,
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
    // Not used for a fallback here — expenseDate is always supplied — kept
    // for signature consistency with recordLedgerEntry, same reasoning as
    // reports.ts's unused-timezone functions.
    timezone: string;
    recordedByUserId?: string | null;
  },
) {
  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "debit",
    category: "expense",
    amountInPaisa: params.amountInPaisa,
    entryDate: params.expenseDate,
    timezone: params.timezone,
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
    timezone: string;
    recordedByUserId?: string | null;
  },
) {
  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "credit",
    category: "expense",
    amountInPaisa: params.amountInPaisa,
    timezone: params.timezone,
    description: `Voided: ${params.categoryLabel}: ${params.description}`,
    referenceType: "expense",
    referenceId: params.expenseId,
    recordedByUserId: params.recordedByUserId ?? null,
  });
}

/**
 * Called from the payroll payment-creation route, right after inserting
 * the payrollPayments row. Deliberately does NOT include the staff
 * member's name anywhere in this ledger entry (description or
 * counterpartyName) — see the long comment above the payrollPayments table
 * in schema.ts: MANAGE_ACCOUNT_BOOKS is held by `manager`, who is
 * explicitly NOT granted VIEW_PAYROLL, so a named entry here would leak
 * exactly what that permission boundary exists to protect. The generic
 * `payPeriodLabel` (e.g. "August 2026") is safe to include since it says
 * nothing about who was paid.
 */
export async function recordPayrollLedgerEntry(
  tx: Transaction,
  params: {
    restaurantId: string;
    payrollPaymentId: string;
    amountInPaisa: number;
    payPeriodLabel?: string | null;
    paymentDate: string;
    // Not used for a fallback here — paymentDate is always supplied — kept
    // for signature consistency with recordLedgerEntry.
    timezone: string;
    recordedByUserId?: string | null;
  },
) {
  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "debit",
    category: "payroll",
    amountInPaisa: params.amountInPaisa,
    entryDate: params.paymentDate,
    timezone: params.timezone,
    description: params.payPeriodLabel ? `Staff salary payment — ${params.payPeriodLabel}` : "Staff salary payment",
    referenceType: "payroll_payment",
    referenceId: params.payrollPaymentId,
    recordedByUserId: params.recordedByUserId ?? null,
  });
}

/**
 * Reverses a previously-recorded payroll debit — called when a payroll
 * payment is voided (e.g. paid to the wrong person, wrong amount). Same
 * "new CREDIT entry, never mutate/delete the original" pattern as
 * reverseExpenseLedgerEntry, and same no-name-leak rule as
 * recordPayrollLedgerEntry above.
 */
export async function reversePayrollLedgerEntry(
  tx: Transaction,
  params: {
    restaurantId: string;
    payrollPaymentId: string;
    amountInPaisa: number;
    payPeriodLabel?: string | null;
    timezone: string;
    recordedByUserId?: string | null;
  },
) {
  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "credit",
    category: "payroll",
    amountInPaisa: params.amountInPaisa,
    timezone: params.timezone,
    description: params.payPeriodLabel
      ? `Voided: Staff salary payment — ${params.payPeriodLabel}`
      : "Voided: Staff salary payment",
    referenceType: "payroll_payment",
    referenceId: params.payrollPaymentId,
    recordedByUserId: params.recordedByUserId ?? null,
  });
}

/**
 * Called from the purchase-creation route, right after the purchase
 * transaction commits its header row. `markAsDue` books the purchase as an
 * outstanding supplier due (dueStatus="outstanding") instead of an
 * immediately-settled debit — used for credit purchases (Section 11-14 of
 * the commercial-launch spec: Supplier Dues / Accounts Payable). The
 * resulting ledgerEntries row is settled via the existing generic
 * `/ledger/[entryId]/settle` route (settleLedgerDue above) — no separate
 * supplier-payment endpoint is needed.
 */
export async function recordPurchaseLedgerEntry(
  tx: Transaction,
  params: {
    restaurantId: string;
    purchaseId: string;
    totalInPaisa: number;
    supplierName?: string | null;
    invoiceNumber?: string | null;
    timezone: string;
    markAsDue?: boolean;
    recordedByUserId?: string | null;
    // Supplier Statement (Gap Audit P1). Stamped on every purchase entry
    // regardless of markAsDue/isCredit — cash purchases get it too, same
    // as every other field here — getSupplierStatement itself is what
    // filters cash purchases back out (dueStatus stays "none" for them
    // forever, since they're never handed to settleLedgerDue; see that
    // function's own doc comment), not this recording step.
    supplierId?: string | null;
  },
) {
  if (params.totalInPaisa <= 0) return null;

  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: "debit",
    category: "purchase",
    amountInPaisa: params.totalInPaisa,
    timezone: params.timezone,
    counterpartyName: params.supplierName ?? null,
    description: params.invoiceNumber ? `Purchase (invoice ${params.invoiceNumber})` : "Purchase",
    referenceType: "purchase",
    referenceId: params.purchaseId,
    markAsDue: params.markAsDue,
    recordedByUserId: params.recordedByUserId ?? null,
    supplierId: params.supplierId ?? null,
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
 * The original row's UPDATE is a compare-and-swap on BOTH dueStatus =
 * 'outstanding' AND settledAmountInPaisa = <the value just read>. Guarding
 * on dueStatus alone is not enough: a *partial* settlement leaves
 * dueStatus at 'outstanding' (only a settlement that reaches the full
 * amount flips it to 'settled'), so two concurrent partial settlements
 * would both still match a dueStatus-only WHERE clause after the first
 * one commits — the second's UPDATE would then overwrite settledAmount
 * with its own stale, independently-computed total, silently losing the
 * first settlement's contribution while still recording BOTH settlement
 * ledger entries below. Including settledAmountInPaisa in the WHERE
 * clause closes that gap the same way the order-status route's
 * compare-and-swap on orders.status does: whoever's UPDATE lands second
 * finds the row's settledAmountInPaisa has already moved and its own
 * WHERE clause simply doesn't match anymore, so it returns no row.
 */
export async function settleLedgerDue(
  tx: Transaction,
  params: {
    restaurantId: string;
    entryId: string;
    amountInPaisa: number;
    note?: string | null;
    timezone: string;
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
        // See the doc comment above: dueStatus alone doesn't change on a
        // partial settlement, so this is the field that actually detects
        // "someone else already settled part of this since I read it."
        eq(ledgerEntries.settledAmountInPaisa, original.settledAmountInPaisa),
      ),
    )
    .returning();

  if (!updated) {
    // Another concurrent settlement already moved this row (either past
    // "outstanding" entirely, or just its settledAmount) between our read
    // and this write — reject cleanly rather than double-booking a
    // settlement entry for money that was already accounted for.
    throw new LedgerError("This entry was just settled by someone else. Please refresh and try again.", 409);
  }

  const settlementEntry = await recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: original.direction,
    category: "due_settlement",
    amountInPaisa: params.amountInPaisa,
    timezone: params.timezone,
    counterpartyName: original.counterpartyName,
    description: `Due settled: ${original.description}`,
    note: params.note ?? null,
    referenceType: "due_settlement",
    referenceId: original.id,
    recordedByUserId: params.recordedByUserId ?? null,
    // Carries the original due's customer link (if any) forward onto its
    // settlement entry too, so a customer's own credit history (see
    // getCustomerOutstandingBalance/settleCustomerCredit below) shows the
    // payment alongside the charge it paid down.
    customerId: original.customerId,
    // Same carry-forward for the supplier side (Gap Audit P1) — a supplier
    // due settled here shows up as a "payment" line in that supplier's own
    // statement (getSupplierStatement in supplier-statement.ts).
    supplierId: original.supplierId,
  });

  return { original: updated, settlementEntry };
}

// ---------------------------------------------------------------------------
// Commercial Launch Phase B.5 — Customer Credit. A customer's "credit" or
// "tab" is deliberately NOT a second ledger/stored-balance column on
// customers — it's simply the sum of that customer's own outstanding
// ledgerEntries rows (linked via customerId, see the column's own comment
// in schema.ts), computed on read. This avoids a second source of truth
// that could drift from the ledger (the way loyaltyPointsBalance is a
// maintained running total is a DIFFERENT, lighter-weight case — points
// aren't money, and every mutation already goes through one choke point,
// recordLoyaltyTransaction). Settling a customer's balance reuses
// settleLedgerDue's own CAS-protected per-entry settlement rather than any
// new update logic — settleCustomerCredit is purely an oldest-first
// allocator across that customer's outstanding entries.
// ---------------------------------------------------------------------------

/**
 * Sums what a customer currently owes across all their outstanding ledger
 * entries (their "tab") — the same amountInPaisa - settledAmountInPaisa
 * math Account Books' own outstanding-dues view uses per entry, just
 * aggregated in SQL rather than loaded row-by-row.
 */
export async function getCustomerOutstandingBalance(
  restaurantId: string,
  customerId: string,
): Promise<number> {
  const [row] = await db
    .select({
      outstandingInPaisa: sql<string>`coalesce(sum(${ledgerEntries.amountInPaisa} - ${ledgerEntries.settledAmountInPaisa}), 0)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.restaurantId, restaurantId),
        eq(ledgerEntries.customerId, customerId),
        eq(ledgerEntries.dueStatus, "outstanding"),
        eq(ledgerEntries.isVoided, false),
      ),
    );
  return Number(row?.outstandingInPaisa ?? 0);
}

/**
 * Commercial completion pass — Data Export gap (customers CSV export needed
 * this same figure for every customer at once). Same math as
 * getCustomerOutstandingBalance above, just grouped by customerId in one
 * query instead of one query per customer — an export can plausibly cover
 * this restaurant's entire customer base, and N+1 queries against it would
 * scale badly.
 */
export async function getCustomerOutstandingBalancesByRestaurant(
  restaurantId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      customerId: ledgerEntries.customerId,
      outstandingInPaisa: sql<string>`coalesce(sum(${ledgerEntries.amountInPaisa} - ${ledgerEntries.settledAmountInPaisa}), 0)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.restaurantId, restaurantId),
        eq(ledgerEntries.dueStatus, "outstanding"),
        eq(ledgerEntries.isVoided, false),
        isNotNull(ledgerEntries.customerId),
      ),
    )
    .groupBy(ledgerEntries.customerId);
  return new Map(rows.map((r) => [r.customerId as string, Number(r.outstandingInPaisa)]));
}

/**
 * Applies a single lump-sum payment against a customer's outstanding tab,
 * oldest charge first (entryDate then createdAt ascending) — the real-world
 * shape of "a regular customer settles up," as opposed to picking one
 * specific past order to pay off (that's still possible directly via
 * settleLedgerDue/the /ledger/[entryId]/settle route, for the rarer case a
 * staff member wants to target one entry specifically).
 *
 * Rejects upfront if the payment would exceed the customer's current total
 * outstanding balance (mirrors settleLedgerDue's own "can't overpay a
 * single entry" rule, just applied to the sum) — no entry is touched in
 * that case. Once allocation starts, each entry is settled via the exact
 * same settleLedgerDue() the single-entry route uses, so if a concurrent
 * settlement (a second staff member, or the single-entry route) touches one
 * of these entries mid-loop, that entry's own CAS throws and — because
 * this always runs inside a caller-provided transaction — the WHOLE
 * lump-sum payment rolls back rather than applying partially. The caller
 * should surface that as "please refresh and try again," same as any other
 * settleLedgerDue 409.
 */
export async function settleCustomerCredit(
  tx: Transaction,
  params: {
    restaurantId: string;
    customerId: string;
    amountInPaisa: number;
    note?: string | null;
    timezone: string;
    recordedByUserId?: string | null;
  },
) {
  if (!Number.isInteger(params.amountInPaisa) || params.amountInPaisa <= 0) {
    throw new LedgerError("Payment amount must be a positive whole-paisa amount.");
  }

  const outstanding = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.restaurantId, params.restaurantId),
        eq(ledgerEntries.customerId, params.customerId),
        eq(ledgerEntries.dueStatus, "outstanding"),
        eq(ledgerEntries.isVoided, false),
      ),
    )
    .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.createdAt));

  const totalOutstandingInPaisa = outstanding.reduce(
    (sum, entry) => sum + (entry.amountInPaisa - entry.settledAmountInPaisa),
    0,
  );
  if (totalOutstandingInPaisa <= 0) {
    throw new LedgerError("This customer has no outstanding balance to settle.");
  }
  if (params.amountInPaisa > totalOutstandingInPaisa) {
    throw new LedgerError(
      `Payment exceeds this customer's outstanding balance (${totalOutstandingInPaisa} paisa owed).`,
    );
  }

  let remainingInPaisa = params.amountInPaisa;
  const settlements: Awaited<ReturnType<typeof settleLedgerDue>>[] = [];
  for (const entry of outstanding) {
    if (remainingInPaisa <= 0) break;
    const dueRemainingInPaisa = entry.amountInPaisa - entry.settledAmountInPaisa;
    if (dueRemainingInPaisa <= 0) continue;
    const applyInPaisa = Math.min(dueRemainingInPaisa, remainingInPaisa);
    const result = await settleLedgerDue(tx, {
      restaurantId: params.restaurantId,
      entryId: entry.id,
      amountInPaisa: applyInPaisa,
      note: params.note ?? null,
      timezone: params.timezone,
      recordedByUserId: params.recordedByUserId ?? null,
    });
    settlements.push(result);
    remainingInPaisa -= applyInPaisa;
  }

  return { settlements, appliedInPaisa: params.amountInPaisa - remainingInPaisa };
}

// ---------------------------------------------------------------------------
// Supplier Statement (Gap Audit P1). Mirrors the Customer Credit section
// immediately above: a supplier's balance is never a second stored
// column, only the sum of that supplier's own ledgerEntries rows (linked
// via supplierId — see the column's own comment in schema.ts). What was
// missing for the supplier side, that the customer side already had via
// settleCustomerCredit, is a lump-sum "pay this supplier" allocator; the
// per-purchase settlement path already existed (settleLedgerDue via the
// generic /ledger/[entryId]/settle route — see recordPurchaseLedgerEntry's
// own comment) and needed no changes. What was missing outright is any way
// to record a manual credit/debit note against a supplier (a price
// correction, a return credit) outside of a purchase — recordSupplierAdjustment
// below is that new mechanism. See supplier-statement.ts for the read side
// that turns both of these, plus ordinary purchases, into one running
// ledger.
// ---------------------------------------------------------------------------

/**
 * Applies a single lump-sum payment against a supplier's outstanding
 * credit-purchase dues, oldest-due-date-then-oldest-entry first — the
 * real-world shape of "we're paying this supplier off," as opposed to
 * settling one specific purchase (still possible directly via
 * settleLedgerDue/the /ledger/[entryId]/settle route, e.g. from the
 * Supplier Dues report's own per-row "Record payment" action).
 *
 * Same all-or-nothing behavior as settleCustomerCredit: rejects upfront if
 * the payment would exceed the supplier's current total outstanding
 * balance (no entry touched in that case), and if a concurrent settlement
 * touches one of these entries mid-loop, that entry's own CAS throws and —
 * because this always runs inside a caller-provided transaction — the
 * WHOLE payment rolls back rather than applying partially.
 */
export async function recordSupplierPayment(
  tx: Transaction,
  params: {
    restaurantId: string;
    supplierId: string;
    amountInPaisa: number;
    note?: string | null;
    timezone: string;
    recordedByUserId?: string | null;
  },
) {
  if (!Number.isInteger(params.amountInPaisa) || params.amountInPaisa <= 0) {
    throw new LedgerError("Payment amount must be a positive whole-paisa amount.");
  }

  const outstanding = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.restaurantId, params.restaurantId),
        eq(ledgerEntries.supplierId, params.supplierId),
        eq(ledgerEntries.category, "purchase"),
        eq(ledgerEntries.dueStatus, "outstanding"),
        eq(ledgerEntries.isVoided, false),
      ),
    )
    .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.createdAt));

  const totalOutstandingInPaisa = outstanding.reduce(
    (sum, entry) => sum + (entry.amountInPaisa - entry.settledAmountInPaisa),
    0,
  );
  if (totalOutstandingInPaisa <= 0) {
    throw new LedgerError("This supplier has no outstanding balance to settle.");
  }
  if (params.amountInPaisa > totalOutstandingInPaisa) {
    throw new LedgerError(
      `Payment exceeds this supplier's outstanding balance (${totalOutstandingInPaisa} paisa owed).`,
    );
  }

  let remainingInPaisa = params.amountInPaisa;
  const settlements: Awaited<ReturnType<typeof settleLedgerDue>>[] = [];
  for (const entry of outstanding) {
    if (remainingInPaisa <= 0) break;
    const dueRemainingInPaisa = entry.amountInPaisa - entry.settledAmountInPaisa;
    if (dueRemainingInPaisa <= 0) continue;
    const applyInPaisa = Math.min(dueRemainingInPaisa, remainingInPaisa);
    const result = await settleLedgerDue(tx, {
      restaurantId: params.restaurantId,
      entryId: entry.id,
      amountInPaisa: applyInPaisa,
      note: params.note ?? null,
      timezone: params.timezone,
      recordedByUserId: params.recordedByUserId ?? null,
    });
    settlements.push(result);
    remainingInPaisa -= applyInPaisa;
  }

  return { settlements, appliedInPaisa: params.amountInPaisa - remainingInPaisa };
}

/**
 * Records a manual adjustment against a supplier's running balance — a
 * credit note (they owe us less: a return, a price correction in our
 * favor) or a debit note (we owe them more: a late fee, a shortfall found
 * after the fact) — outside of the normal purchase flow. There is
 * deliberately no purchases/ledger_entries row this adjusts; it is its own
 * standalone ledgerEntries row, category "other" (see
 * MANUAL_LEDGER_CATEGORIES — "other" is the generic bucket every manual
 * entry not tied to a more specific flow uses) with referenceType
 * "supplier_adjustment" so getSupplierStatement can find it via the same
 * supplierId + category filter it uses for everything else.
 *
 * direction carries the sign the same way it does everywhere else in this
 * file: "debit" increases what this restaurant owes the supplier (same
 * direction as a purchase); "credit" decreases it (same direction as a
 * payment). amountInPaisa is always positive; the caller picks direction
 * to say which way the adjustment moves the balance.
 */
export async function recordSupplierAdjustment(
  tx: Transaction,
  params: {
    restaurantId: string;
    supplierId: string;
    direction: LedgerDirection;
    amountInPaisa: number;
    description: string;
    note?: string | null;
    entryDate?: string;
    timezone: string;
    recordedByUserId?: string | null;
  },
) {
  return recordLedgerEntry(tx, {
    restaurantId: params.restaurantId,
    direction: params.direction,
    category: "other",
    amountInPaisa: params.amountInPaisa,
    entryDate: params.entryDate,
    timezone: params.timezone,
    description: params.description,
    note: params.note ?? null,
    referenceType: "supplier_adjustment",
    referenceId: null,
    recordedByUserId: params.recordedByUserId ?? null,
    supplierId: params.supplierId,
  });
}
