import "server-only";
import { and, count, eq, gte, max } from "drizzle-orm";
import { db } from "@/db";
import { orders, restaurants } from "@/db/schema";
import { computeHealthScore, type HealthScore } from "./health-score";

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
