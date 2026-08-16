/**
 * Phase 10 — the fixed plan catalog. Deliberately a plain, dependency-free
 * module (no "server-only", no DB import), same pattern as
 * expense-categories.ts/reservation-status.ts, so it's shared unmodified
 * between the billing UI, the admin UI, and the staff-limit check on the
 * invite route.
 *
 * PRICING IS A PLACEHOLDER. There is no payment gateway wired up yet
 * (that's Phase 11's job) — these numbers exist so the billing/admin UI
 * has something real to render and compare against, not because they're a
 * finalized business decision. Update before ever taking a real payment.
 */

export const PLAN_KEYS = ["starter", "growth", "pro"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export type Plan = {
  key: PlanKey;
  name: string;
  tagline: string;
  priceInPaisaMonthly: number;
  /** null = unlimited. Counts active non-owner staff (see maxStaffForRestaurant). */
  maxStaff: number | null;
  /** null = unlimited. Counts active branches (see maxBranchesForRestaurant). */
  maxBranches: number | null;
  highlight?: boolean;
  features: string[];
};

export const PLANS: Plan[] = [
  {
    key: "starter",
    name: "Starter",
    tagline: "For a single small restaurant, cafe, or momo shop getting started.",
    priceInPaisaMonthly: 150_000, // Rs 1,500/mo
    maxStaff: 5,
    maxBranches: 1,
    features: [
      "QR table ordering",
      "POS & billing",
      "Kitchen display (KDS)",
      "Up to 5 staff accounts",
      "1 branch",
    ],
  },
  {
    key: "growth",
    name: "Growth",
    tagline: "For a busy restaurant that needs the full toolkit.",
    priceInPaisaMonthly: 350_000, // Rs 3,500/mo
    maxStaff: 15,
    maxBranches: 3,
    highlight: true,
    features: [
      "Everything in Starter",
      "Inventory & recipe costing",
      "Customers & loyalty program",
      "Expense tracking & reports",
      "Up to 15 staff accounts",
      "Up to 3 branches",
    ],
  },
  {
    key: "pro",
    name: "Pro",
    tagline: "For established restaurants that want everything, unlimited.",
    priceInPaisaMonthly: 650_000, // Rs 6,500/mo
    maxStaff: null,
    maxBranches: null,
    features: [
      "Everything in Growth",
      "Reservations",
      "Unlimited staff accounts",
      "Unlimited branches",
      "Priority support",
    ],
  },
];

export const PLAN_MAP: Record<PlanKey, Plan> = Object.fromEntries(
  PLANS.map((p) => [p.key, p]),
) as Record<PlanKey, Plan>;

export function getPlanByKey(key: string | null | undefined): Plan | null {
  if (!key) return null;
  return PLAN_MAP[key as PlanKey] ?? null;
}

/**
 * Generous default while a restaurant is still on its free trial and
 * hasn't committed to (or been assigned) a plan yet — evaluating the
 * product shouldn't mean bumping into a staff-seat wall on day 2.
 */
export const TRIAL_MAX_STAFF = 10;

/**
 * The staff-seat ceiling that currently applies to a restaurant: its
 * assigned plan's limit once one is set, otherwise the trial default.
 * Returns null for "unlimited" (Pro plan).
 */
export function maxStaffForRestaurant(restaurant: { planKey: string | null }): number | null {
  const plan = getPlanByKey(restaurant.planKey);
  if (!plan) return TRIAL_MAX_STAFF;
  return plan.maxStaff;
}

/**
 * Trial default for branches: 2, not 1 — generous enough that a restaurant
 * actually evaluating whether RestroMitra fits a multi-location business can
 * try that during the trial itself, rather than being forced to commit to
 * a paid plan before finding out. (Contrast with TRIAL_MAX_STAFF's "10" —
 * same spirit of not gating evaluation, just a smaller number because
 * branches are a much bigger structural commitment than a staff seat.)
 */
export const TRIAL_MAX_BRANCHES = 2;

/**
 * The branch-count ceiling that currently applies to a restaurant: its
 * assigned plan's limit once one is set, otherwise the trial default.
 * Returns null for "unlimited" (Pro plan).
 */
export function maxBranchesForRestaurant(restaurant: { planKey: string | null }): number | null {
  const plan = getPlanByKey(restaurant.planKey);
  if (!plan) return TRIAL_MAX_BRANCHES;
  return plan.maxBranches;
}
