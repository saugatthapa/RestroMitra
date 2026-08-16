/**
 * Loyalty point -> cash redemption math — Phase 17. Deliberately a plain,
 * dependency-free module (no "server-only", no DB import), same pattern as
 * order-adjustments.ts: shared unmodified between the POS UI's live preview
 * and the order-creation API route, and trivially unit-testable.
 *
 * Points are earned at 1 point per Rs 10 (POINTS_EARN_RATE_PAISA in
 * loyalty.ts) spent on a completed order. Redemption uses a separate,
 * independent rate — 1 point = Rs 1 — a simple, easy-to-explain-at-the-
 * till value rather than trying to make redemption the exact inverse of
 * earning (which would make 1 point worth Rs 10, an unusually generous
 * redemption rate for this market). Both rates are fixed, platform-wide
 * MVP defaults, same scope note as POINTS_EARN_RATE_PAISA.
 */
export const POINTS_REDEMPTION_VALUE_PAISA = 100;

export type LoyaltyRedemptionResolution = {
  /** Never more than requested, the customer's balance, or what the order can absorb. */
  pointsToRedeem: number;
  redemptionValueInPaisa: number;
};

/**
 * Clamps a requested point redemption down to what's actually usable:
 * never more than the customer's spendable balance, and never more than
 * the order's subtotal can absorb (a discount can never exceed the
 * subtotal — same rule computeDiscountInPaisa enforces for manual
 * discounts, see order-adjustments.ts). Deliberately clamps the POINT
 * count down to a value that converts evenly at the redemption rate,
 * rather than clamping the paisa value and leaving a fractional-point
 * remainder — the loyalty ledger only ever debits whole points.
 */
export function resolveLoyaltyRedemption(params: {
  requestedPoints: number;
  customerPointsBalance: number;
  subtotalInPaisa: number;
}): LoyaltyRedemptionResolution {
  const maxAffordablePoints = Math.floor(
    Math.max(0, params.subtotalInPaisa) / POINTS_REDEMPTION_VALUE_PAISA,
  );
  const pointsToRedeem = Math.max(
    0,
    Math.min(
      Math.floor(params.requestedPoints),
      Math.floor(params.customerPointsBalance),
      maxAffordablePoints,
    ),
  );
  return {
    pointsToRedeem,
    redemptionValueInPaisa: pointsToRedeem * POINTS_REDEMPTION_VALUE_PAISA,
  };
}
