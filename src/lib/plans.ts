/**
 * Plan catalog — TYPES AND PURE MATH ONLY. Deliberately a plain,
 * dependency-free module (no "server-only", no DB import), same "pure
 * counterpart to a *-db.ts module" pattern as src/lib/subscription.ts vs
 * subscription-db.ts — this file is safe to import from a client
 * component (BillingBoard, the admin restaurant detail page), which is
 * exactly why the actual catalog data can't live here.
 *
 * Platform Control Center (Phase 4) — the plan catalog itself (the actual
 * starter/growth/pro rows, their price/limits/features) moved to the `plans`
 * DB table, admin-editable at /admin/plans, so a platform admin can add a
 * genuinely new plan or change pricing without a code change. The DB-backed
 * loaders (getActivePlans, getPlanByKey, getEffectivePlan,
 * maxStaffForRestaurant, maxBranchesForRestaurant) live in
 * src/lib/plans-db.ts — server-only, since they hit the database.
 *
 * PRICING HISTORY (kept for context — the actual live numbers are in the
 * `plans` table, seeded by drizzle/0056_plan_catalog_table.sql with these
 * exact values):
 *
 * Researched against the actual Nepal small-restaurant-POS market (August
 * 2026), not a guess. The previous numbers here (Rs 1,500/3,500/6,500 per
 * month) were an explicit placeholder — replaced after checking what a
 * restaurant in RestroMitra's actual target segment (a single small
 * restaurant/cafe/momo shop, Itahari-first) would see from every direct
 * competitor with public pricing:
 *   - LekhaPatra: Rs 500/mo (Rs 4,999/yr) entry, Rs 800/mo (Rs 7,999/yr) top
 *   - Hamro SAN: Rs 599 / 999 / 1,199 per month (3 tiers, monthly only)
 *   - Restronp: Rs 500 / 1,000 / 2,000 per month equivalent (annual-only billing)
 *   - NRestro: Rs 833/mo entry, ~Rs 1,250–2,000/mo "most popular" tier
 * These land RestroMitra at the upper end of that competitive band
 * (justified by real differentiators none of the above advertise — an AI
 * assistant, offline-capable POS, eSewa/Khalti payment gateways included
 * rather than gated, a website builder), not above it.
 *
 * PHASE 25c RECALIBRATION (Aug 2026) — Growth only, Rs 1,799 → Rs 1,399/mo,
 * benchmarked against RestroHub's Standard tier (Rs 15,400/yr). Starter and
 * Pro untouched. Still true after Phase 4's migration to a DB table — these
 * ARE the seeded values, not superseded by it.
 *
 * This is a live catalog, and existing restaurants already active on a plan
 * must NOT have their bill silently drop (or rise) just because the catalog
 * changed — see restaurants.lockedMonthlyPriceInPaisa in src/db/schema.ts
 * and applyPriceLock()/getEffectivePlan() below, which every price-
 * displaying route/component should read through rather than a raw
 * getPlanByKey() when rendering a SPECIFIC restaurant's current plan.
 * getActivePlans()/getPlanByKey() alone are still correct for "what would a
 * NEW signup pay" (the plan-picker grid, the marketing page).
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

// Phase 4 — no longer a fixed literal union: a platform admin can add a
// new plan key from /admin/plans without a code change, so this is just a
// readability alias for "a plan's slug," not a closed set. Validation of
// "does this key actually exist" happens at the DB layer (plans-db.ts),
// never at the type layer.
export type PlanKey = string;

export type Plan = {
  key: PlanKey;
  name: string;
  tagline: string;
  priceInPaisaMonthly: number;
  /** null = unlimited. Counts active non-owner staff (see maxStaffForRestaurant in plans-db.ts). */
  maxStaff: number | null;
  /** null = unlimited. Counts active branches (see maxBranchesForRestaurant in plans-db.ts). */
  maxBranches: number | null;
  highlight: boolean;
  /** Free marketing copy shown on /billing's plan cards, e.g. "QR table ordering". */
  features: string[];
  /** Machine-checkable references into src/lib/feature-catalog.ts's FEATURES — what Phase 5's entitlement engine actually gates on. */
  featureKeys: string[];
  /** Phase 7 — null = unlimited. Monthly AI assistant request quota (see aiMonthlyRequestLimitForRestaurant in plans-db.ts, which applies restaurants.aiMonthlyRequestLimitOverride first when one is set). */
  aiMonthlyRequestLimit: number | null;
  /** Catalog display order (ascending) — see getActivePlans()/getAllPlansForAdmin() in plans-db.ts. */
  sortOrder: number;
  isActive: boolean;
};

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

/**
 * Pure price-lock transform, extracted out of the old (DB-backed)
 * getEffectivePlan so the actual arithmetic stays unit-testable without a
 * database. See restaurants.lockedMonthlyPriceInPaisa's schema comment for
 * why this exists (price grandfathering — a catalog price change must
 * never silently reprice an existing restaurant).
 */
export function applyPriceLock(plan: Plan, lockedMonthlyPriceInPaisa?: number | null): Plan {
  if (lockedMonthlyPriceInPaisa == null) return plan;
  return { ...plan, priceInPaisaMonthly: lockedMonthlyPriceInPaisa };
}

/**
 * Generous default while a restaurant is still on its free trial and
 * hasn't committed to (or been assigned) a plan yet — evaluating the
 * product shouldn't mean bumping into a staff-seat wall on day 2.
 */
export const TRIAL_MAX_STAFF = 10;

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
 * Phase 7 — generous default monthly AI-assistant request quota while a
 * restaurant is still on its free trial and hasn't been assigned a plan
 * yet, same "don't gate evaluation" spirit as TRIAL_MAX_STAFF/
 * TRIAL_MAX_BRANCHES above. 100 requests/month is comfortably more than a
 * single owner/manager checking their numbers a few times a day would use
 * during a trial, while still being a real ceiling (not unlimited) so a
 * misconfigured/abusive trial signup can't run up provider costs.
 */
export const TRIAL_AI_MONTHLY_REQUEST_LIMIT = 100;
