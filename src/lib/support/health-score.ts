/**
 * Platform Control Center (Phase 9) — a deliberately SIMPLE, EXPLAINABLE
 * tenant health score for support triage. Pure and dependency-free (no
 * "server-only", no DB import), same pattern as subscription.ts's
 * computeSubscriptionAccess: the DB-backed signal-gathering lives in
 * health-score-db.ts, this file is just the scoring math, directly
 * unit-testable without a database.
 *
 * Deliberately NOT a black-box ML score — every point lost is a named,
 * itemized `reasons` entry a support agent can read and immediately
 * understand ("why is this tenant at 55?"). Starts at 100 and only ever
 * subtracts; there's no way to characterize a genuinely healthy tenant
 * that just isn't shown here, which keeps the rubric auditable at a
 * glance rather than needing to reverse-engineer a formula.
 */

export type HealthBand = "healthy" | "watch" | "at_risk";

export type HealthScoreReason = {
  label: string;
  delta: number; // always negative — points subtracted, for this reason
};

export type HealthScore = {
  score: number; // 0-100
  band: HealthBand;
  reasons: HealthScoreReason[];
};

export type HealthScoreInput = {
  isActive: boolean;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  /** Null when the restaurant has never taken an order. */
  lastOrderAt: Date | null;
  ordersLast30Days: number;
  /** Onboarding-completed date, so a brand-new tenant with no orders yet
   * isn't penalized for "no orders in 30 days" before it's had a chance. */
  onboardingCompletedAt: Date | null;
  now?: Date;
};

const LOW_VOLUME_THRESHOLD = 5;
const TRIAL_ENDING_SOON_DAYS = 3;
const GRACE_PERIOD_DAYS_AFTER_ONBOARDING = 14;

function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

export function computeHealthScore(input: HealthScoreInput): HealthScore {
  const now = input.now ?? new Date();
  const reasons: HealthScoreReason[] = [];

  if (!input.isActive) {
    reasons.push({ label: "Restaurant is suspended", delta: -40 });
  }

  if (input.subscriptionStatus === "past_due") {
    reasons.push({ label: "Subscription is past due", delta: -20 });
  } else if (input.subscriptionStatus === "paused") {
    reasons.push({ label: "Subscription is paused", delta: -25 });
  } else if (input.subscriptionStatus === "cancelled" || input.subscriptionStatus === "expired") {
    reasons.push({
      label: `Subscription is ${input.subscriptionStatus}`,
      delta: -35,
    });
  } else if (input.subscriptionStatus === "trialing" && input.trialEndsAt) {
    const daysLeft = daysBetween(input.trialEndsAt, now);
    if (daysLeft <= TRIAL_ENDING_SOON_DAYS) {
      reasons.push({
        label:
          daysLeft <= 0
            ? "Trial has ended"
            : `Trial ends in ${Math.ceil(daysLeft)} day${Math.ceil(daysLeft) === 1 ? "" : "s"}`,
        delta: -10,
      });
    }
  }

  // Order-activity signals only apply once a tenant has had a fair chance
  // to place orders — a restaurant that finished onboarding yesterday
  // hasn't "gone quiet," it just hasn't started yet.
  const pastGracePeriod =
    !input.onboardingCompletedAt ||
    daysBetween(now, input.onboardingCompletedAt) >= GRACE_PERIOD_DAYS_AFTER_ONBOARDING;

  if (pastGracePeriod) {
    if (!input.lastOrderAt) {
      reasons.push({ label: "No orders placed yet", delta: -25 });
    } else {
      const daysSinceLastOrder = daysBetween(now, input.lastOrderAt);
      if (daysSinceLastOrder > 30) {
        reasons.push({ label: "No orders in the last 30 days", delta: -25 });
      } else if (input.ordersLast30Days < LOW_VOLUME_THRESHOLD) {
        reasons.push({
          label: `Low order volume (${input.ordersLast30Days} order${input.ordersLast30Days === 1 ? "" : "s"} in the last 30 days)`,
          delta: -10,
        });
      }
    }
  }

  const rawScore = 100 + reasons.reduce((sum, r) => sum + r.delta, 0);
  const score = Math.max(0, Math.min(100, rawScore));

  const band: HealthBand = score >= 75 ? "healthy" : score >= 45 ? "watch" : "at_risk";

  return { score, band, reasons };
}

export const HEALTH_BAND_LABELS: Record<HealthBand, string> = {
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
};
