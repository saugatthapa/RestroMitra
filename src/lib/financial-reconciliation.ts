import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import { orders, payments } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { restaurantStartOfDay } from "@/lib/restaurant-date";
import type { PaymentMethod } from "@/lib/payments";

export class FinancialReconciliationError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

/**
 * Commercial Launch Phase A.8 — Financial Reconciliation.
 *
 * Scope, deliberately: this reconciles the `payments` table itself — the
 * true source of truth for every payment method — rather than only
 * `paymentGatewayTransactions` (which tracks gateway-callback status for
 * eSewa/Khalti online payments, but has no row at all for a card payment
 * taken on a physical POS terminal; reconciling only that table would
 * silently miss card payments entirely).
 *
 * "cash" is EXCLUDED from every function below (enforced here, not as a DB
 * constraint — see the reconciledAt/reconciledByUserId column comments in
 * schema.ts): cash is already fully reconciled by the existing Cash
 * Register shift-close / Daily Closing features, which physically count
 * the till against the expected figure. Reconciling it again here would
 * duplicate that mechanism (see the master spec's Section 1: never
 * duplicate existing logic) against a DIFFERENT, weaker kind of evidence
 * (nobody "confirms cash against a bank statement" — there's nothing to
 * look up). card/mobile_wallet/other payments never touch a till; the
 * money settles to the restaurant's bank account separately (often days
 * later, sometimes net of a processor fee), and until this phase nothing
 * tracked whether that settlement was ever actually confirmed.
 *
 * There is no bank-API or payment-gateway settlement integration in this
 * codebase, so this is deliberately a MANUAL checklist, not automated
 * matching — see the master spec's "report BLOCKED for anything
 * impossible, never fake it" rule. A human checks their own bank/gateway
 * statement outside this app, then marks the corresponding payment(s)
 * reconciled here.
 */
export const RECONCILABLE_PAYMENT_METHODS: PaymentMethod[] = ["card", "mobile_wallet", "other"];

function assertReconcilableMethod(method: PaymentMethod) {
  if (method === "cash") {
    throw new FinancialReconciliationError(
      "Cash payments are reconciled through Cash Register shift close / Daily Closing, not here.",
    );
  }
}

export type ReconciliationFilters = {
  branchId?: string;
  method?: PaymentMethod;
  from?: string; // inclusive, ISO date/datetime
  to?: string; // exclusive, ISO date/datetime
};

export type ReconciliationStatus = "unreconciled" | "reconciled" | "all";

export type PaymentReconciliationRow = {
  id: string;
  orderId: string;
  orderNumber: string;
  branchId: string;
  amountInPaisa: number;
  method: PaymentMethod;
  note: string | null;
  createdAt: Date;
  reconciledAt: Date | null;
  reconciledByUserId: string | null;
};

// A bare "YYYY-MM-DD" date (no time component) is the ambiguous case —
// see resolveDateFilterInstant's own doc comment just below.
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolves a reconciliation `from`/`to` filter value (see
 * ReconciliationFilters — either a bare "YYYY-MM-DD" date or a full ISO
 * datetime, per reconciliationQuerySchema's dateOrDatetime validator) into
 * an absolute instant to compare against payments.createdAt.
 *
 * QA hardening pass (Phase 10 / master prompt timezone audit) — this used
 * to be a bare `new Date(value)` for both from and to. For a full ISO
 * datetime that's fine (it already carries its own offset/Z, so it's
 * unambiguous). But for a BARE date, `new Date("2026-08-01")` parses as UTC
 * midnight per the ECMA-262 date-time string spec — not the restaurant's
 * own midnight. For Asia/Kathmandu (UTC+5:45), that silently shifted every
 * bare-date filter boundary ~5h45m later than a restaurant owner picking
 * "from 2026-08-01" / "to 2026-08-02" (to see all of Aug 1) would expect:
 * the "from" bound excluded roughly the first 6 hours of that day's
 * payments, and the "to" bound (exclusive, per ReconciliationFilters' own
 * doc comment) included roughly the first 6 hours of the day AFTER the
 * intended cutoff. Same bug class, same fix, as the dayBounds() helper in
 * reports.ts (restaurantStartOfDay) — see that file's own doc comment for
 * the fuller history of this bug pattern across the codebase.
 *
 * A full ISO datetime is passed through untouched; only a bare date gets
 * resolved against the restaurant's timezone. This preserves the exact
 * inclusive/exclusive semantics ReconciliationFilters already documents —
 * only the INSTANT a bare date resolves to changes, not how from/to are
 * compared against it.
 */
function resolveDateFilterInstant(value: string, timezone: string): Date {
  return BARE_DATE_RE.test(value) ? restaurantStartOfDay(timezone, value) : new Date(value);
}

// payments has no branchId of its own — every payment belongs to exactly
// one order (orderId NOT NULL), so branch scoping always goes through an
// inner join onto orders, same rationale as getPaymentMethodBreakdown /
// getTipsSummary in reports.ts.
function buildReconciliationWhere(
  restaurantId: string,
  filters: ReconciliationFilters,
  status: ReconciliationStatus,
  timezone: string,
) {
  const conditions = [
    eq(payments.restaurantId, restaurantId),
    // "cash" is never reconcilable here — see the module doc comment.
    inArray(payments.method, RECONCILABLE_PAYMENT_METHODS),
  ];
  if (filters.branchId) conditions.push(eq(orders.branchId, filters.branchId));
  if (filters.method) {
    assertReconcilableMethod(filters.method);
    conditions.push(eq(payments.method, filters.method));
  }
  if (filters.from) conditions.push(gte(payments.createdAt, resolveDateFilterInstant(filters.from, timezone)));
  if (filters.to) conditions.push(lt(payments.createdAt, resolveDateFilterInstant(filters.to, timezone)));
  if (status === "unreconciled") conditions.push(isNull(payments.reconciledAt));
  if (status === "reconciled") conditions.push(isNotNull(payments.reconciledAt));
  return and(...conditions);
}

/**
 * Lists payments (card/mobile_wallet/other only) in a restaurant, optionally
 * scoped by branch/method/date-range and filtered by reconciliation status.
 * Ordered oldest-first for "unreconciled" (work through the backlog in the
 * order it accrued) and newest-first otherwise.
 */
export async function listPaymentsForReconciliation(
  restaurantId: string,
  filters: ReconciliationFilters = {},
  status: ReconciliationStatus = "unreconciled",
  limit = 500,
  timezone = "Asia/Kathmandu",
): Promise<PaymentReconciliationRow[]> {
  const rows = await db
    .select({
      id: payments.id,
      orderId: payments.orderId,
      orderNumber: orders.orderNumber,
      branchId: orders.branchId,
      amountInPaisa: payments.amountInPaisa,
      method: payments.method,
      note: payments.note,
      createdAt: payments.createdAt,
      reconciledAt: payments.reconciledAt,
      reconciledByUserId: payments.reconciledByUserId,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .where(buildReconciliationWhere(restaurantId, filters, status, timezone))
    .orderBy(status === "unreconciled" ? asc(payments.createdAt) : desc(payments.createdAt))
    .limit(limit);

  return rows.map((r) => ({ ...r, method: r.method as PaymentMethod }));
}

export type ReconciliationSummary = {
  method: PaymentMethod;
  reconciledCount: number;
  reconciledTotalInPaisa: number;
  unreconciledCount: number;
  unreconciledTotalInPaisa: number;
};

/**
 * Per-method totals, split by reconciled/unreconciled — the dashboard's
 * headline numbers ("how much card money is still unconfirmed"). Amounts
 * are summed as-is (a refund's negative amountInPaisa nets out), matching
 * getPaymentMethodBreakdown's own convention in reports.ts.
 */
export async function getReconciliationSummary(
  restaurantId: string,
  filters: Omit<ReconciliationFilters, "method"> = {},
  timezone = "Asia/Kathmandu",
): Promise<ReconciliationSummary[]> {
  const rows = await db
    .select({
      method: payments.method,
      reconciledCount: sql<string>`coalesce(sum(case when ${payments.reconciledAt} is not null then 1 else 0 end), 0)`,
      reconciledTotalInPaisa: sql<string>`coalesce(sum(case when ${payments.reconciledAt} is not null then ${payments.amountInPaisa} else 0 end), 0)`,
      unreconciledCount: sql<string>`coalesce(sum(case when ${payments.reconciledAt} is null then 1 else 0 end), 0)`,
      unreconciledTotalInPaisa: sql<string>`coalesce(sum(case when ${payments.reconciledAt} is null then ${payments.amountInPaisa} else 0 end), 0)`,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .where(buildReconciliationWhere(restaurantId, filters, "all", timezone))
    .groupBy(payments.method)
    .orderBy(asc(payments.method));

  return rows.map((r) => ({
    method: r.method as PaymentMethod,
    reconciledCount: Number(r.reconciledCount),
    reconciledTotalInPaisa: Number(r.reconciledTotalInPaisa),
    unreconciledCount: Number(r.unreconciledCount),
    unreconciledTotalInPaisa: Number(r.unreconciledTotalInPaisa),
  }));
}

async function loadOwnedPayment(tx: Transaction, restaurantId: string, paymentId: string) {
  const [row] = await tx
    .select({
      id: payments.id,
      method: payments.method,
      reconciledAt: payments.reconciledAt,
    })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.restaurantId, restaurantId)))
    .limit(1);
  if (!row) {
    throw new FinancialReconciliationError("Payment not found.", 404);
  }
  return row;
}

/**
 * Marks a single payment reconciled — the human has checked their bank or
 * gateway statement and confirmed this payment settled. CAS-style: the
 * UPDATE's own WHERE re-checks reconciledAt IS NULL, so two concurrent
 * "mark reconciled" calls for the same payment can't both succeed (the
 * loser gets a clean 409, not a silently-overwritten reconciledByUserId).
 */
export async function markPaymentReconciled(
  tx: Transaction,
  params: { restaurantId: string; paymentId: string; reconciledByUserId: string },
) {
  const existing = await loadOwnedPayment(tx, params.restaurantId, params.paymentId);
  assertReconcilableMethod(existing.method as PaymentMethod);
  if (existing.reconciledAt) {
    throw new FinancialReconciliationError("This payment is already marked reconciled.", 409);
  }

  const [updated] = await tx
    .update(payments)
    .set({ reconciledAt: new Date(), reconciledByUserId: params.reconciledByUserId })
    .where(and(eq(payments.id, params.paymentId), isNull(payments.reconciledAt)))
    .returning();

  if (!updated) {
    // Lost the race between the read above and this UPDATE.
    throw new FinancialReconciliationError("This payment is already marked reconciled.", 409);
  }
  return updated;
}

/**
 * Reverses a mistaken reconciliation mark. Deliberately gated at the same
 * trust tier as marking (MANAGE_ACCOUNT_BOOKS, see the route) rather than
 * a separate/higher permission — this is a low-stakes, frequently-corrected
 * checklist action (fat-fingered the wrong row, statement turned out to be
 * for a different payment), not a financial write like voiding a purchase.
 */
export async function unmarkPaymentReconciled(
  tx: Transaction,
  params: { restaurantId: string; paymentId: string },
) {
  const existing = await loadOwnedPayment(tx, params.restaurantId, params.paymentId);
  if (!existing.reconciledAt) {
    throw new FinancialReconciliationError("This payment is not marked reconciled.", 409);
  }

  const [updated] = await tx
    .update(payments)
    .set({ reconciledAt: null, reconciledByUserId: null })
    .where(and(eq(payments.id, params.paymentId), isNotNull(payments.reconciledAt)))
    .returning();

  if (!updated) {
    throw new FinancialReconciliationError("This payment is not marked reconciled.", 409);
  }
  return updated;
}
