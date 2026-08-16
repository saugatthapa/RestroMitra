/**
 * Discount + service charge math — Phase 13. Deliberately a plain,
 * dependency-free module (no "server-only", no DB import), same pattern as
 * order-status.ts/payments.ts, so it's shared unmodified between API routes
 * and the POS/bill-view UI and trivially unit-testable.
 *
 * PRICING POLICY (read this before changing any of the formulas below):
 *
 *   totalInPaisa = subtotalInPaisa - discountInPaisa + serviceChargeInPaisa + taxInPaisa
 *
 * Both discount and service charge are computed against subtotalInPaisa
 * ONLY — never against taxInPaisa, and never against each other. This is a
 * deliberate simplification, not an oversight:
 *
 *   - taxInPaisa is computed per line item in computeOrderPricing()
 *     (src/lib/orders.ts) from each menu item's own tax rate, BEFORE any
 *     order-level discount/service-charge exists. Re-deriving it to account
 *     for a discount would mean reworking that already-correct, tested
 *     per-line pricing engine — explicitly out of scope for this phase
 *     ("do not rewrite working systems"). So tax is simply left as-is:
 *     discounting or adding a service charge never changes taxInPaisa.
 *   - Service charge is computed on the food/beverage subtotal, matching
 *     standard restaurant convention in Nepal (service charge on the bill
 *     before tax, not compounded on top of tax).
 *   - Discount is likewise computed on the subtotal — "10% off your food
 *     bill" — not on the tax or the service charge.
 *
 * This means a restaurant whose tax law requires VAT to be computed on the
 * discounted/service-charge-inclusive amount would need a different
 * formula — flagged as a known limitation in PHASE_13_NOTES.md, not
 * silently assumed correct for every jurisdiction.
 */

export const DISCOUNT_TYPES = ["percentage", "flat"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

const BASIS_POINTS_DENOMINATOR = 10_000;

/**
 * Percentage discount value is basis points (0-10000, i.e. 0-100.00%);
 * flat discount value is a paisa amount. Either way the result is clamped
 * to [0, subtotalInPaisa] — a discount can never make the discounted
 * portion negative, and a flat discount larger than the subtotal simply
 * zeroes it out rather than pushing the order into negative territory.
 */
export function computeDiscountInPaisa(
  discountType: DiscountType | null | undefined,
  discountValue: number | null | undefined,
  subtotalInPaisa: number,
): number {
  if (!discountType || !discountValue) return 0;
  const raw =
    discountType === "percentage"
      ? Math.round((subtotalInPaisa * discountValue) / BASIS_POINTS_DENOMINATOR)
      : discountValue;
  return Math.max(0, Math.min(raw, subtotalInPaisa));
}

/** Service charge basis points (0-10000) applied to the subtotal, floored at 0. */
export function computeServiceChargeInPaisa(
  serviceChargeBasisPoints: number | null | undefined,
  subtotalInPaisa: number,
): number {
  if (!serviceChargeBasisPoints) return 0;
  return Math.max(0, Math.round((subtotalInPaisa * serviceChargeBasisPoints) / BASIS_POINTS_DENOMINATOR));
}

export type OrderAdjustmentsInput = {
  subtotalInPaisa: number;
  taxInPaisa: number;
  discountType?: DiscountType | null;
  discountValue?: number | null;
  serviceChargeBasisPoints?: number | null;
};

export type OrderAdjustmentsResult = {
  discountInPaisa: number;
  serviceChargeInPaisa: number;
  totalInPaisa: number;
};

/**
 * The single place totalInPaisa is derived once discount/service charge
 * exist — called from order creation (orders/route.ts) and the dedicated
 * adjustments route (orders/[orderId]/adjustments/route.ts), so the two
 * call sites can never drift into different formulas.
 */
export function computeOrderTotals(input: OrderAdjustmentsInput): OrderAdjustmentsResult {
  const discountInPaisa = computeDiscountInPaisa(
    input.discountType,
    input.discountValue,
    input.subtotalInPaisa,
  );
  const serviceChargeInPaisa = computeServiceChargeInPaisa(
    input.serviceChargeBasisPoints,
    input.subtotalInPaisa,
  );
  const totalInPaisa =
    input.subtotalInPaisa - discountInPaisa + serviceChargeInPaisa + input.taxInPaisa;
  return { discountInPaisa, serviceChargeInPaisa, totalInPaisa };
}
