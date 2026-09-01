import "server-only";
import { and, count, eq, gte, max } from "drizzle-orm";
import { db } from "@/db";
import { orders, restaurants } from "@/db/schema";
import { computeHealthScore, type HealthBand, type HealthScore } from "./health-score";

/**
 * Platform Control Center (Phase 9) — gathers the DB signals
 * computeHealthScore() needs for one restaurant, then delegates to the
 * pure scoring function. Kept as a thin wrapper (same split as
 * subscription.ts/subscription-db.ts) so the actual rubric stays
 * unit-testable without a database.
 */
export async function getRestaurantHealthScore(restaurantId: string): Promise<HealthScore> {
  const [restaurant] = await db
    .select({
      isActive: restaurants.isActive,
      subscriptionStatus: restaurants.subscriptionStatus,
      trialEndsAt: restaurants.trialEndsAt,
      onboardingCompletedAt: restaurants.onboardingCompletedAt,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);

  if (!restaurant) {
    throw new Error("Restaurant not found.");
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [lastOrderRow] = await db
    .select({ lastOrderAt: max(orders.createdAt) })
    .from(orders)
    .where(eq(orders.restaurantId, restaurantId));

  const [last30Row] = await db
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.restaurantId, restaurantId), gte(orders.createdAt, thirtyDaysAgo)));

  return computeHealthScore({
    isActive: restaurant.isActive,
    subscriptionStatus: restaurant.subscriptionStatus,
    trialEndsAt: restaurant.trialEndsAt,
    onboardingCompletedAt: restaurant.onboardingCompletedAt,
    lastOrderAt: lastOrderRow?.lastOrderAt ?? null,
    ordersLast30Days: last30Row?.n ?? 0,
  });
}

export type PlatformHealthScoreRow = {
  restaurantId: string;
  restaurantName: string;
  restaurantSlug: string;
  healthScore: HealthScore;
};

/**
 * Gap-audit P1 fix (Finding 3) — the platform-wide counterpart to
 * getRestaurantHealthScore() above: every restaurant's health score in
 * ONE pass, not a per-restaurant loop. computeHealthScore() itself stays
 * exactly as-is (pure, unit-tested independently — see health-score.ts) —
 * this function's whole job is gathering its DB inputs for every
 * restaurant with exactly three aggregate queries (restaurants,
 * last-order-per-restaurant, orders-in-last-30-days-per-restaurant) rather
 * than three queries PER restaurant, which is what a naive
 * `Promise.all(restaurants.map(getRestaurantHealthScore))` would do —
 * fine at today's tenant count, but a query-count-proportional-to-tenant-
 * count function is exactly the kind of thing that quietly becomes a
 * platform-page timeout as the platform grows, so this earns its own
 * batched implementation now rather than "when it becomes a problem."
 *
 * Sorted worst-first (lowest score first) so "who needs attention" is
 * always the top of the list without the caller having to sort again.
 */
export async function getPlatformHealthScores(now: Date = new Date()): Promise<PlatformHealthScoreRow[]> {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [allRestaurants, lastOrderRows, last30Rows] = await Promise.all([
    db
      .select({
        id: restaurants.id,
        name: restaurants.name,
        slug: restaurants.slug,
        isActive: restaurants.isActive,
        subscriptionStatus: restaurants.subscriptionStatus,
        trialEndsAt: restaurants.trialEndsAt,
        onboardingCompletedAt: restaurants.onboardingCompletedAt,
      })
      .from(restaurants),
    db
      .select({ restaurantId: orders.restaurantId, lastOrderAt: max(orders.createdAt) })
      .from(orders)
      .groupBy(orders.restaurantId),
    db
      .select({ restaurantId: orders.restaurantId, n: count() })
      .from(orders)
      .where(gte(orders.createdAt, thirtyDaysAgo))
      .groupBy(orders.restaurantId),
  ]);

  const lastOrderByRestaurant = new Map(lastOrderRows.map((r) => [r.restaurantId, r.lastOrderAt]));
  const last30ByRestaurant = new Map(last30Rows.map((r) => [r.restaurantId, r.n]));

  const rows = allRestaurants.map((restaurant) => ({
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    restaurantSlug: restaurant.slug,
    healthScore: computeHealthScore({
      isActive: restaurant.isActive,
      subscriptionStatus: restaurant.subscriptionStatus,
      trialEndsAt: restaurant.trialEndsAt,
      onboardingCompletedAt: restaurant.onboardingCompletedAt,
      lastOrderAt: lastOrderByRestaurant.get(restaurant.id) ?? null,
      ordersLast30Days: last30ByRestaurant.get(restaurant.id) ?? 0,
      now,
    }),
  }));

  rows.sort((a, b) => a.healthScore.score - b.healthScore.score);
  return rows;
}

/** Restaurants whose current health band is at or below `maxBand` (default: only "at_risk"), worst-first. The dashboard's proactive "these N tenants need attention" list — see getPlatformHealthScores' own doc comment for why this is a batched aggregate rather than a per-tenant lookup. */
export async function getAtRiskTenants(
  maxBand: HealthBand = "at_risk",
  now: Date = new Date(),
): Promise<PlatformHealthScoreRow[]> {
  const bandRank: Record<HealthBand, number> = { healthy: 2, watch: 1, at_risk: 0 };
  const threshold = bandRank[maxBand];
  const all = await getPlatformHealthScores(now);
  return all.filter((r) => bandRank[r.healthScore.band] <= threshold);
}
