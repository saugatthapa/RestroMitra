/**
 * Loyalty tier thresholds — Phase 8. Deliberately a plain, dependency-free
 * module (no "server-only", no DB import), same pattern as order-status.ts/
 * payments.ts/kds.ts, so it's shared unmodified between the customer API
 * routes and the dashboard customer detail view.
 *
 * Tiers are driven by LIFETIME points earned, not the current spendable
 * balance — redeeming points for a reward shouldn't demote a loyal
 * customer back down a tier the same visit they used their points. This
 * is a deliberate choice matching (and, we think, slightly improving on)
 * the tiered-loyalty model competitors in this market ship: a points
 * balance that resets your status every time you spend it isn't much of
 * a "status" at all.
 *
 * Thresholds are a fixed, platform-wide MVP default — see
 * PHASE_8b_NOTES.md's "Known gaps" for why per-restaurant customization
 * is deferred rather than half-built.
 */

export const LOYALTY_TIERS = [
  { name: "Bronze", minPoints: 0 },
  { name: "Silver", minPoints: 500 },
  { name: "Gold", minPoints: 1500 },
  { name: "Platinum", minPoints: 3000 },
] as const;

export type LoyaltyTierName = (typeof LOYALTY_TIERS)[number]["name"];

/** The highest tier a customer qualifies for, given their lifetime points earned. */
export function tierForPoints(lifetimePointsEarned: number): LoyaltyTierName {
  let current: LoyaltyTierName = LOYALTY_TIERS[0].name;
  for (const tier of LOYALTY_TIERS) {
    if (lifetimePointsEarned >= tier.minPoints) current = tier.name;
  }
  return current;
}

/** Points still needed to reach the next tier, or null if already at the top tier. */
export function pointsToNextTier(lifetimePointsEarned: number): number | null {
  const next = LOYALTY_TIERS.find((tier) => tier.minPoints > lifetimePointsEarned);
  return next ? next.minPoints - lifetimePointsEarned : null;
}
