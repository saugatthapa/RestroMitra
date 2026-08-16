/**
 * Billing math for Phase 5. Deliberately dependency-free (no "server-only",
 * no DB import) so it's shared, unmodified, between API routes and the
 * dashboard bill view, and trivially unit-tested — same pattern as
 * src/lib/order-status.ts.
 */

export type PaymentStatus = "unpaid" | "partially_paid" | "paid";

export const PAYMENT_METHODS = ["cash", "card", "mobile_wallet", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  mobile_wallet: "Mobile wallet (eSewa/Khalti)",
  other: "Other",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partially paid",
  paid: "Paid",
};

/** Sum of a set of payment rows' amounts — refunds (negative amounts) net out automatically. */
export function computeNetPaid(paymentAmountsInPaisa: number[]): number {
  return paymentAmountsInPaisa.reduce((sum, amount) => sum + amount, 0);
}

/**
 * Derives payment status purely from totalInPaisa vs netPaidInPaisa. There
 * is no separate "refunded" status — a fully refunded order's netPaid
 * drops back to (or below) zero and it simply reads "unpaid" again; the
 * refund itself stays visible as its own line in the payment history for
 * anyone who needs to see what happened, rather than being collapsed into
 * a status label.
 */
export function computePaymentStatus(
  totalInPaisa: number,
  netPaidInPaisa: number,
): PaymentStatus {
  if (netPaidInPaisa >= totalInPaisa && totalInPaisa > 0) return "paid";
  if (netPaidInPaisa > 0) return "partially_paid";
  return "unpaid";
}

export function computeRemainingDue(totalInPaisa: number, netPaidInPaisa: number): number {
  return Math.max(0, totalInPaisa - netPaidInPaisa);
}

export type BillingSummary = {
  totalInPaisa: number;
  netPaidInPaisa: number;
  remainingDueInPaisa: number;
  paymentStatus: PaymentStatus;
  /** Phase 13 — gratuity collected across this order's payments. Never
   * counted toward netPaidInPaisa/remainingDueInPaisa — see the tipInPaisa
   * column comment in schema.ts. */
  tipTotalInPaisa: number;
};

/** Sum of a set of payment rows' tips — always additive (no "negative tip"
 * concept the way refunds are negative payments). */
export function computeTipTotal(tipAmountsInPaisa: number[]): number {
  return tipAmountsInPaisa.reduce((sum, amount) => sum + amount, 0);
}

export function computeBillingSummary(
  totalInPaisa: number,
  paymentAmountsInPaisa: number[],
  tipAmountsInPaisa: number[] = [],
): BillingSummary {
  const netPaidInPaisa = computeNetPaid(paymentAmountsInPaisa);
  return {
    totalInPaisa,
    netPaidInPaisa,
    remainingDueInPaisa: computeRemainingDue(totalInPaisa, netPaidInPaisa),
    paymentStatus: computePaymentStatus(totalInPaisa, netPaidInPaisa),
    tipTotalInPaisa: computeTipTotal(tipAmountsInPaisa),
  };
}
