import "server-only";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { branches, entitlementOverrides, featureFlags, orders, plans, restaurants, users } from "@/db/schema";
import { getAllPlansForAdmin } from "@/lib/plans-db";

/**
 * Gap-audit P1 fix (Finding 1) — the platform dashboard's data source.
 * Every query here is a single aggregate (COUNT/SUM/GROUP BY), never a
 * per-restaurant loop, so this stays cheap regardless of how many tenants
 * are on the platform — same "aggregate SQL, not N+1" convention as
 * src/lib/system/health-db.ts and src/lib/ai/usage-db.ts's platform-wide
 * summaries.
 */

/** [dayStart, nextDayStart) in UTC for "now" — deliberately UTC, same reasoning as usage-db.ts's currentUtcMonthBounds: a platform-wide "today" reset at UTC midnight is unambiguous across every tenant regardless of its own restaurant.timezone. */
function currentUtcDayBounds(now: Date = new Date()): { dayStart: Date; nextDayStart: Date } {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, nextDayStart };
}

function currentUtcMonthBounds(now: Date = new Date()): { monthStart: Date; nextMonthStart: Date } {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { monthStart, nextMonthStart };
}

export type DashboardMetrics = {
  users: { total: number; active: number };
  branches: { total: number; active: number };
  orders: { today: number; thisMonth: number };
  revenue: {
    /** Monthly recurring revenue from restaurants whose subscription is currently `active` — sum of each one's effective price (its price lock when set, otherwise its plan's catalog price). */
    activeMonthlyInPaisa: number;
    /** Same sum, but for restaurants currently `past_due` — money billed but not yet collected, a leading indicator distinct from "healthy" MRR. */
    pastDueMonthlyInPaisa: number;
  };
  planDistribution: { planKey: string | null; planName: string; restaurantCount: number }[];
  featureUsage: {
    featureKey: string;
    name: string;
    /** feature_flags.default_enabled — the platform-wide default a restaurant gets absent any override; null when this key has no feature_flags row (plan-only feature). */
    defaultEnabled: boolean | null;
    /** Restaurants whose current plan's featureKeys already includes this key (before any override is applied). */
    viaPlanCount: number;
    /** Restaurants with an explicit entitlement_overrides row forcing this ON. */
    overrideGrantedCount: number;
    /** Restaurants with an explicit entitlement_overrides row forcing this OFF. */
    overrideRevokedCount: number;
  }[];
};

/** Sum of each active/past_due restaurant's effective monthly price (price lock, else its plan's catalog price) — a single aggregate query per status, not a per-restaurant loop. */
async function sumEffectiveMonthlyRevenue(subscriptionStatus: "active" | "past_due"): Promise<number> {
  const [row] = await db
    .select({
      totalInPaisa: sql<string>`coalesce(sum(coalesce(${restaurants.lockedMonthlyPriceInPaisa}, ${plans.priceInPaisaMonthly})), 0)`,
    })
    .from(restaurants)
    .innerJoin(plans, eq(restaurants.planKey, plans.key))
    .where(eq(restaurants.subscriptionStatus, subscriptionStatus));
  return Number(row?.totalInPaisa ?? 0);
}

export async function getDashboardMetrics(now: Date = new Date()): Promise<DashboardMetrics> {
  const { dayStart, nextDayStart } = currentUtcDayBounds(now);
  const { monthStart, nextMonthStart } = currentUtcMonthBounds(now);

  const [
    [totalUsersRow],
    [activeUsersRow],
    [totalBranchesRow],
    [activeBranchesRow],
    [ordersTodayRow],
    [ordersThisMonthRow],
    activeMonthlyInPaisa,
    pastDueMonthlyInPaisa,
    planDistRows,
    flagRows,
    overrideRows,
    allPlans,
  ] = await Promise.all([
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(users).where(eq(users.isActive, true)),
    db.select({ n: count() }).from(branches),
    db.select({ n: count() }).from(branches).where(eq(branches.isActive, true)),
    db.select({ n: count() }).from(orders).where(and(gte(orders.createdAt, dayStart), lt(orders.createdAt, nextDayStart))),
    db.select({ n: count() }).from(orders).where(and(gte(orders.createdAt, monthStart), lt(orders.createdAt, nextMonthStart))),
    sumEffectiveMonthlyRevenue("active"),
    sumEffectiveMonthlyRevenue("past_due"),
    db
      .select({ planKey: restaurants.planKey, planName: plans.name, restaurantCount: count() })
      .from(restaurants)
      .leftJoin(plans, eq(restaurants.planKey, plans.key))
      .groupBy(restaurants.planKey, plans.name),
    db.select({ key: featureFlags.key, name: featureFlags.name, defaultEnabled: featureFlags.defaultEnabled }).from(featureFlags),
    db
      .select({ featureKey: entitlementOverrides.featureKey, granted: entitlementOverrides.granted, n: count() })
      .from(entitlementOverrides)
      .groupBy(entitlementOverrides.featureKey, entitlementOverrides.granted),
    getAllPlansForAdmin(),
  ]);

  // Restaurant counts per plan key, for deriving "how many restaurants get
  // feature X via their plan" below without a second per-feature query —
  // every plan's featureKeys array is already loaded (getAllPlansForAdmin
  // is React-cached) and planDistRows already has the count per plan.
  const restaurantCountByPlanKey = new Map<string, number>();
  for (const row of planDistRows) {
    if (row.planKey) restaurantCountByPlanKey.set(row.planKey, row.restaurantCount);
  }

  const viaPlanCountByFeatureKey = new Map<string, number>();
  for (const plan of allPlans) {
    const restaurantCount = restaurantCountByPlanKey.get(plan.key) ?? 0;
    if (restaurantCount === 0) continue;
    for (const featureKey of plan.featureKeys) {
      viaPlanCountByFeatureKey.set(featureKey, (viaPlanCountByFeatureKey.get(featureKey) ?? 0) + restaurantCount);
    }
  }

  const grantedByFeatureKey = new Map<string, number>();
  const revokedByFeatureKey = new Map<string, number>();
  for (const row of overrideRows) {
    const target = row.granted ? grantedByFeatureKey : revokedByFeatureKey;
    target.set(row.featureKey, (target.get(row.featureKey) ?? 0) + row.n);
  }

  const featureKeys = new Set<string>([
    ...flagRows.map((f) => f.key),
    ...viaPlanCountByFeatureKey.keys(),
    ...grantedByFeatureKey.keys(),
    ...revokedByFeatureKey.keys(),
  ]);
  const flagByKey = new Map(flagRows.map((f) => [f.key, f]));

  const featureUsage = Array.from(featureKeys)
    .map((featureKey) => {
      const flag = flagByKey.get(featureKey);
      return {
        featureKey,
        name: flag?.name ?? featureKey,
        defaultEnabled: flag?.defaultEnabled ?? null,
        viaPlanCount: viaPlanCountByFeatureKey.get(featureKey) ?? 0,
        overrideGrantedCount: grantedByFeatureKey.get(featureKey) ?? 0,
        overrideRevokedCount: revokedByFeatureKey.get(featureKey) ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    users: { total: totalUsersRow?.n ?? 0, active: activeUsersRow?.n ?? 0 },
    branches: { total: totalBranchesRow?.n ?? 0, active: activeBranchesRow?.n ?? 0 },
    orders: { today: ordersTodayRow?.n ?? 0, thisMonth: ordersThisMonthRow?.n ?? 0 },
    revenue: { activeMonthlyInPaisa, pastDueMonthlyInPaisa },
    planDistribution: planDistRows.map((r) => ({
      planKey: r.planKey,
      planName: r.planName ?? "No plan assigned",
      restaurantCount: r.restaurantCount,
    })),
    featureUsage,
  };
}
