import "server-only";
import { cache } from "react";
import { asc, and, eq } from "drizzle-orm";
import { db } from "@/db";
import { entitlementOverrides, featureFlags, restaurants } from "@/db/schema";
import { getEffectivePlan } from "@/lib/plans-db";
import { FEATURES } from "@/lib/feature-catalog";
import { resolveFeatureAccess, type EntitlementResult } from "@/lib/entitlements";
import { HttpError } from "@/lib/http-error";

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

  const overrideByKey = new Map(
    overrides.map((o) => [o.featureKey, { granted: o.granted, expiresAt: o.expiresAt }]),
  );
  const flagByKey = new Map(flags.map((f) => [f.key, f.defaultEnabled]));

  const allKeys = new Set<string>([
    ...(Object.values(FEATURES) as string[]),
    ...overrides.map((o) => o.featureKey),
    ...flags.map((f) => f.key),
  ]);

  return [...allKeys].sort().map((key) =>
    resolveFeatureAccess(key, {
      planFeatureKeys: plan?.featureKeys ?? [],
      override: overrideByKey.get(key)?.granted,
      overrideExpiresAt: overrideByKey.get(key)?.expiresAt,
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
      .select({ granted: entitlementOverrides.granted, expiresAt: entitlementOverrides.expiresAt })
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
    overrideExpiresAt: overrideRow?.expiresAt,
    flagDefault: flag?.defaultEnabled,
  }).granted;
}

/**
 * Phase 17 (Attendance overhaul, Track B — Plan-gated attendance tiers) —
 * thrown by requireFeature() below. A distinct HttpError subclass (same
 * "typed error → toErrorResponse() renders it" pattern as
 * SubscriptionRequiredError/TenantSuspendedError in rbac/guard.ts) so a
 * route can catch this one specifically if it ever needs a custom message,
 * while resolveRestaurantContext's default handling (a plain 403) covers
 * every ordinary call site without each route needing its own try/catch —
 * unlike AI_ASSISTANT's own AiAssistantNotEntitledError (ask-db.ts), which
 * predates this and is caught by hand in its one call site because it also
 * needs to distinguish a quota error from an entitlement error there. A
 * plain feature gate with no second failure mode to distinguish doesn't
 * need that — see resolveRestaurantContext's own comment for why this one
 * is wired centrally instead.
 */
export class FeatureNotEntitledError extends HttpError {
  featureKey: string;
  constructor(featureKey: string, message = "This feature isn't included in your current plan.") {
    super(message, 403);
    this.featureKey = featureKey;
  }
}

/** Throws FeatureNotEntitledError when `restaurantId` doesn't currently have `featureKey` — the assert-style sibling of hasFeature() above, for a route gate that should fail closed. */
export async function requireFeature(restaurantId: string, featureKey: string, message?: string): Promise<void> {
  const entitled = await hasFeature(restaurantId, featureKey);
  if (!entitled) {
    throw new FeatureNotEntitledError(featureKey, message);
  }
}

/**
 * Sets (or replaces) one tenant's forced yes/no on one feature key. Upsert
 * on the (restaurantId, featureKey) unique index — a second override for
 * the same tenant+key updates the existing row (new reason, new granted
 * value, new actor, new expiry) rather than creating a duplicate; the
 * audit_logs entry the caller records alongside this is what preserves the
 * history of each change, same "state lives here, history lives in
 * audit_logs" split as entitlementOverrides' own schema comment.
 *
 * `expiresAt` is a full replace, not a merge, same as every other field
 * here: omitting it (or passing null) on a re-override clears any expiry
 * the previous row had rather than preserving it — "set an override" always
 * means "this is now the complete state of the override," never "patch one
 * field of it."
 */
export async function setEntitlementOverride(params: {
  restaurantId: string;
  featureKey: string;
  granted: boolean;
  reason: string;
  createdByUserId: string;
  /** Null (the default) = no expiry, permanent until manually revoked. See entitlementOverrides.expiresAt's own schema comment. */
  expiresAt?: Date | null;
}) {
  const [row] = await db
    .insert(entitlementOverrides)
    .values({
      restaurantId: params.restaurantId,
      featureKey: params.featureKey,
      granted: params.granted,
      reason: params.reason,
      createdByUserId: params.createdByUserId,
      expiresAt: params.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [entitlementOverrides.restaurantId, entitlementOverrides.featureKey],
      set: {
        granted: params.granted,
        reason: params.reason,
        createdByUserId: params.createdByUserId,
        expiresAt: params.expiresAt ?? null,
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
