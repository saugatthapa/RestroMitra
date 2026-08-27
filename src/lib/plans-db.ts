import "server-only";
import { cache } from "react";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { plans } from "@/db/schema";
import { TRIAL_MAX_STAFF, TRIAL_MAX_BRANCHES, applyPriceLock, type Plan } from "./plans";

/**
 * Platform Control Center (Phase 4) — DB-backed counterpart to plans.ts's
 * pure types/math (same split as subscription.ts/subscription-db.ts).
 * Every function here hits the `plans` table — never import this from a
 * client component; import the pure plans.ts instead and fetch data
 * through an API route (see /api/restaurants/[slug]/billing and
 * /api/admin/plans).
 */

function rowToPlan(row: typeof plans.$inferSelect): Plan {
  return {
    key: row.key,
    name: row.name,
    tagline: row.tagline,
    priceInPaisaMonthly: row.priceInPaisaMonthly,
    maxStaff: row.maxStaff,
    maxBranches: row.maxBranches,
    highlight: row.highlight,
    features: row.features,
    featureKeys: row.featureKeys,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

/**
 * Every plan a NEW signup can choose from (the /billing plan-picker grid,
 * the marketing page) — active plans only, in catalog display order.
 * Cached per-request (React's cache(), same convention as getSession/
 * getUserRestaurants) since it's read on nearly every billing-related page.
 */
export const getActivePlans = cache(async (): Promise<Plan[]> => {
  const rows = await db
    .select()
    .from(plans)
    .where(eq(plans.isActive, true))
    .orderBy(asc(plans.sortOrder), asc(plans.key));
  return rows.map(rowToPlan);
});

/** Every plan, including retired ones — for /admin/plans' own management UI, where a platform admin needs to see (and potentially re-activate) a plan no longer offered to new signups. */
export const getAllPlansForAdmin = cache(async (): Promise<Plan[]> => {
  const rows = await db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.key));
  return rows.map(rowToPlan);
});

/**
 * Resolves ANY plan by key, active or not — a restaurant already assigned
 * a since-retired plan must still be able to see/display it (isActive only
 * filters the "offer to a new signup" listing, never lookup-by-key).
 */
export const getPlanByKey = cache(async (key: string | null | undefined): Promise<Plan | null> => {
  if (!key) return null;
  const [row] = await db.select().from(plans).where(eq(plans.key, key)).limit(1);
  return row ? rowToPlan(row) : null;
});

/**
 * The plan a SPECIFIC restaurant is actually being charged — same features
 * and limits as the catalog entry, but with priceInPaisaMonthly overridden
 * to `lockedMonthlyPriceInPaisa` when one is set. See plans.ts's
 * applyPriceLock and restaurants.lockedMonthlyPriceInPaisa's schema
 * comment for the full price-grandfathering reasoning.
 *
 * Use this (not getPlanByKey) anywhere a specific restaurant's own current
 * plan/price is being displayed — e.g. the billing page's "you're on
 * Growth at Rs X/mo" line, or a platform admin's restaurant detail view.
 * getActivePlans/getPlanByKey are still correct for "what would a new
 * signup pay" — those should always show today's catalog price, never a
 * lock that doesn't apply to them.
 */
export async function getEffectivePlan(restaurant: {
  planKey: string | null | undefined;
  lockedMonthlyPriceInPaisa?: number | null;
}): Promise<Plan | null> {
  const plan = await getPlanByKey(restaurant.planKey);
  if (!plan) return null;
  return applyPriceLock(plan, restaurant.lockedMonthlyPriceInPaisa);
}

/**
 * The staff-seat ceiling that currently applies to a restaurant: its
 * assigned plan's limit once one is set, otherwise the trial default.
 * Returns null for "unlimited".
 */
export async function maxStaffForRestaurant(restaurant: { planKey: string | null }): Promise<number | null> {
  const plan = await getPlanByKey(restaurant.planKey);
  if (!plan) return TRIAL_MAX_STAFF;
  return plan.maxStaff;
}

/**
 * The branch-count ceiling that currently applies to a restaurant: its
 * assigned plan's limit once one is set, otherwise the trial default.
 * Returns null for "unlimited".
 */
export async function maxBranchesForRestaurant(restaurant: { planKey: string | null }): Promise<number | null> {
  const plan = await getPlanByKey(restaurant.planKey);
  if (!plan) return TRIAL_MAX_BRANCHES;
  return plan.maxBranches;
}
