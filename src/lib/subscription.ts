/**
 * Phase 10 — pure subscription-access math. Deliberately dependency-free
 * (no "server-only", no DB import), same pattern as order-status.ts, so
 * it's directly unit-testable and shared unmodified between the DB-backed
 * reconciliation in subscription-db.ts, the dashboard layout's redirect
 * decision, and the billing UI.
 */

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type AccessReason =
  | "active"
  | "trialing"
  | "past_due"
  | "trial_expired"
  | "cancelled"
  | "expired";

export type SubscriptionAccess = {
  allowed: boolean;
  reason: AccessReason;
};

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: "Free trial",
  active: "Active",
  past_due: "Past due",
  cancelled: "Cancelled",
  expired: "Expired",
};

/**
 * Whether a restaurant currently has access, purely from its stored
 * status + trial end date — independent of whether anything has yet
 * written "expired" back to the DB (see subscription-db.ts's
 * reconcileSubscriptionStatus for the write side). This is what makes the
 * check safe to call from a read-only server component (the dashboard
 * layout) without needing a DB write on every page load.
 *
 * `past_due` is a deliberate grace period: access stays on so a
 * restaurant doesn't get locked out the moment a (future, Phase-11)
 * payment fails — only `cancelled`/`expired` actually block.
 */
export function computeSubscriptionAccess(params: {
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  now?: Date;
}): SubscriptionAccess {
  const now = params.now ?? new Date();

  switch (params.subscriptionStatus as SubscriptionStatus) {
    case "active":
      return { allowed: true, reason: "active" };
    case "past_due":
      return { allowed: true, reason: "past_due" };
    case "trialing": {
      if (params.trialEndsAt && params.trialEndsAt.getTime() <= now.getTime()) {
        return { allowed: false, reason: "trial_expired" };
      }
      return { allowed: true, reason: "trialing" };
    }
    case "cancelled":
      return { allowed: false, reason: "cancelled" };
    case "expired":
      return { allowed: false, reason: "expired" };
    default:
      // An unrecognized status fails closed rather than defaulting open.
      return { allowed: false, reason: "expired" };
  }
}

export function daysRemaining(trialEndsAt: Date | null, now: Date = new Date()): number | null {
  if (!trialEndsAt) return null;
  const ms = trialEndsAt.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}
