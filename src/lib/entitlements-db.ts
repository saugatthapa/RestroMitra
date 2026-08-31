import "server-only";
import { cache } from "react";
import { asc, and, eq } from "drizzle-orm";
import { db } from "@/db";
import { entitlementOverrides, featureFlags, restaurants } from "@/db/schema";
import { getEffectivePlan } from "@/lib/plans-db";
import { FEATURES } from "@/lib/feature-catalog";
import { resolveFeatureAccess, type EntitlementResult } from "@/lib/entitlements";

/**
 * Platform Control Center (Phase 5) — DB-backed half of the entitlement
 * engine. Every function here hits the database — never import this from a
 * client component; the pure resolveFeatureAccess() in entitlements.ts is
 * what's safe to reuse client-side (the admin "explain" screen fetches
 * this module's output through an API route and renders it with that pure
 * function's own result shape).
 */

export const getAllFeatureFlags = cache(async () => {
  return db.select().from(featureFlags).orderBy(asc(featureFlags.key));
});

export const getFeatureFlagByKey = cache(async (key: string) => {
  const [row] = await db.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
  return row ?? null;
});

export const getEntitlementOverridesForRestaurant = cache(async (restaurantId: string) => {
  return db
    .select()
    .from(entitlementOverrides)
    .where(eq(entitlementOverrides.restaurantId, restaurantId));
});

/**
 * Every feature key worth showing a platform admin for one restaurant:
 * every key in the code-defined FEATURES catalog, PLUS any key that has an
 * active override or flag row even if it's not (yet) in FEATURES — so a
 * stale or in-progress rollout key never silently disappears from the
 * debug screen just because feature-catalog.ts hasn't been updated yet.
 */
export async function explainTenantAccess(restaurantId: string): Promise<EntitlementResult[]> {
  const [restaurantRow] = await db
    .select({ planKey: restaurants.planKey, lockedMonthlyPriceInPaisa: restaurants.lockedMonthlyPriceInPaisa })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);

  const [plan, overrides, flags] = await Promise.all([
    restaurantRow ? getEffectivePlan(restaurantRow) : Promise.resolve(null),
    getEntitlementOverridesForRestaurant(restaurantId),
    getAllFeatureFlags(),
  ]);

  const overrideByKey = new Map(overrides.map((o) => [o.featureKey, o.granted]));
  const flagByKey = new Map(flags.map((f) => [f.key, f.defaultEnabled]));

  const allKeys = new Set<string>([
    ...(Object.values(FEATURES) as string[]),
    ...overrides.map((o) => o.featureKey),
    ...flags.map((f) => f.key),
  ]);

  return [...allKeys].sort().map((key) =>
    resolveFeatureAccess(key, {
      planFeatureKeys: plan?.featureKeys ?? [],
      override: overrideByKey.has(key) ? overrideByKey.get(key) : undefined,
      flagDefault: flagByKey.has(key) ? flagByKey.get(key) : undefined,
    }),
  );
}

/**
 * The single "does this restaurant have this feature right now" check —
 * what an actual route gate should call (Phase 17's plan-gated attendance
 * tiers, and any future feature gate). Deliberately not cached beyond a
 * single request the way getEffectivePlan/getEntitlementOverridesFor
 * Restaurant already are — this composes those cached reads, so repeated
 * calls within one request stay cheap without an extra cache layer here.
 */
export async function hasFeature(restaurantId: string, featureKey: string): Promise<boolean> {
  const [restaurantRow] = await db
    .select({ planKey: restaurants.planKey, lockedMonthlyPriceInPaisa: restaurants.lockedMonthlyPriceInPaisa })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);

  const [plan, overrideRow, flag] = await Promise.all([
    restaurantRow ? getEffectivePlan(restaurantRow) : Promise.resolve(null),
    db
      .select({ granted: entitlementOverrides.granted })
      .from(entitlementOverrides)
      .where(
        and(
          eq(entitlementOverrides.restaurantId, restaurantId),
          eq(entitlementOverrides.featureKey, featureKey),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    getFeatureFlagByKey(featureKey),
  ]);

  return resolveFeatureAccess(featureKey, {
    planFeatureKeys: plan?.featureKeys ?? [],
    override: overrideRow?.granted,
    flagDefault: flag?.defaultEnabled,
  }).granted;
}

/**
 * Sets (or replaces) one tenant's forced yes/no on one feature key. Upsert
 * on the (restaurantId, featureKey) unique index — a second override for
 * the same tenant+key updates the existing row (new reason, new granted
 * value, new actor) rather than creating a duplicate; the audit_logs entry
 * the caller records alongside this is what preserves the history of each
 * change, same "state lives here, history lives in audit_logs" split as
 * entitlementOverrides' own schema comment.
 */
export async function setEntitlementOverride(params: {
  restaurantId: string;
  featureKey: string;
  granted: boolean;
  reason: string;
  createdByUserId: string;
}) {
  const [row] = await db
    .insert(entitlementOverrides)
    .values({
      restaurantId: params.restaurantId,
      featureKey: params.featureKey,
      granted: params.granted,
      reason: params.reason,
      createdByUserId: params.createdByUserId,
    })
    .onConflictDoUpdate({
      target: [entitlementOverrides.restaurantId, entitlementOverrides.featureKey],
      set: {
        granted: params.granted,
        reason: params.reason,
        createdByUserId: params.createdByUserId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/** Removes a tenant's override for one feature key — reverts to whatever the plan/flag would otherwise decide. */
export async function clearEntitlementOverride(restaurantId: string, featureKey: string) {
  await db
    .delete(entitlementOverrides)
    .where(
      and(
        eq(entitlementOverrides.restaurantId, restaurantId),
        eq(entitlementOverrides.featureKey, featureKey),
      ),
    );
}
