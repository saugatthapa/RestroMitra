/**
 * Phase 10 — the fixed plan catalog. Deliberately a plain, dependency-free
 * module (no "server-only", no DB import), same pattern as
 * expense-categories.ts/reservation-status.ts, so it's shared unmodified
 * between the billing UI, the admin UI, and the staff-limit check on the
 * invite route.
 *
 * PRICING — researched against the actual Nepal small-restaurant-POS market
 * (August 2026), not a guess. The previous numbers here (Rs 1,500/3,500/
 * 6,500 per month) were an explicit placeholder — this pass replaced them
 * after checking what a restaurant in RestroMitra's actual target segment
 * (a single small restaurant/cafe/momo shop, Itahari-first) would see from
 * every direct competitor with public pricing:
 *   - LekhaPatra: Rs 500/mo (Rs 4,999/yr) entry, Rs 800/mo (Rs 7,999/yr) top
 *   - Hamro SAN: Rs 599 / 999 / 1,199 per month (3 tiers, monthly only)
 *   - Restronp: Rs 500 / 1,000 / 2,000 per month equivalent (annual-only billing)
 *   - NRestro: Rs 833/mo entry, ~Rs 1,250–2,000/mo "most popular" tier
 * The old placeholder priced RestroMitra's entry tier ABOVE every
 * competitor's most-popular mid tier, and its mid/top tiers above anything
 * else in the market — a real barrier to adoption in a price-sensitive
 * market. These numbers land RestroMitra at the upper end of that
 * competitive band (justified by real differentiators none of the above
 * advertise — an AI assistant, offline-capable POS, eSewa/Khalti payment
 * gateways included rather than gated, a website builder), not above it.
 *
 * Yearly = 10x the monthly price (2 months free) at every tier — the same
 * "pay 10, get 12" framing LekhaPatra and most SaaS pricing uses, simple
 * enough to explain to a non-technical owner without a discount-percent
 * calculation. See yearlyPriceInPaisa().
 *
 * Still not wired to a real payment gateway for subscriptions themselves
 * (BillingBoard's "Request this plan" is a manual sales-assist flow, not
 * checkout) — these are the numbers to actually quote, but confirm before
 * changing what's charged to any restaurant already on a paid plan.
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
    priceInPaisaMonthly: 79_900, // Rs 799/mo
    maxStaff: 5,
    maxBranches: 1,
    features: [
      "QR table ordering",
      "POS & billing",
      "Kitchen display (KDS)",
      "eSewa & Khalti payments",
      "Up to 5 staff accounts",
      "1 branch",
    ],
  },
  {
    key: "growth",
    name: "Growth",
    tagline: "For a busy restaurant that needs the full toolkit.",
    priceInPaisaMonthly: 179_900, // Rs 1,799/mo
    maxStaff: 15,
    maxBranches: 3,
    highlight: true,
    features: [
      "Everything in Starter",
      "Inventory & recipe costing",
      "Customers & loyalty program",
      "AI restaurant assistant",
      "Website builder",
      "Expense tracking & reports",
      "Up to 15 staff accounts",
      "Up to 3 branches",
    ],
  },
  {
    key: "pro",
    name: "Pro",
    tagline: "For established restaurants that want everything, unlimited.",
    priceInPaisaMonthly: 349_900, // Rs 3,499/mo
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

/** Yearly price for a plan — 10x the monthly rate (2 months free), rounded
 * to the nearest rupee. Kept as a function of priceInPaisaMonthly rather
 * than a second stored field so the "2 months free" relationship can never
 * drift out of sync if the monthly price changes. */
export function yearlyPriceInPaisa(plan: Plan): number {
  return plan.priceInPaisaMonthly * 10;
}

/** What a restaurant effectively pays per month when billed yearly —
 * for display ("Rs X/mo, billed yearly") next to the full yearly price. */
export function monthlyEquivalentWhenYearlyInPaisa(plan: Plan): number {
  return Math.round(yearlyPriceInPaisa(plan) / 12);
}

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
