/**
 * Gap-audit P1 fix (Finding 1) — integration test for getDashboardMetrics()
 * (src/lib/admin/dashboard-metrics-db.ts), the platform dashboard's data
 * source. Since this reads platform-wide tables (not scoped to a
 * caller-supplied restaurant id, and this suite's own seed data
 * accumulates alongside whatever else exists in the target DB), every
 * assertion here is written as "our seeded rows are present/counted
 * correctly within the totals," never "the totals equal exactly N" —
 * the totals themselves are a whole-platform aggregate this test doesn't
 * own.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same convention as the
 * other DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("getDashboardMetrics (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let dashboardMetricsDb: typeof import("@/lib/admin/dashboard-metrics-db");

  const suffix = Math.random().toString(36).slice(2, 8);
  const planKey = `test-dash-plan-${suffix}`;
  const now = new Date("2026-06-15T12:00:00.000Z");

  let restaurantActiveId: string;
  let restaurantPastDueId: string;
  let branchId: string;
  let userId: string;
  let featureFlagKey: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    dashboardMetricsDb = await import("@/lib/admin/dashboard-metrics-db");

    await db.insert(schema.plans).values({
      key: planKey,
      name: "TEST Dashboard Plan",
      tagline: "A test plan for dashboard metrics.",
      priceInPaisaMonthly: 250_000, // Rs 2,500/mo
      highlight: false,
      features: [],
      featureKeys: ["test_dashboard_feature"],
      sortOrder: 999,
      isActive: true,
    });

    const [active, pastDue] = await db
      .insert(schema.restaurants)
      .values([
        {
          slug: `test-dash-active-${suffix}`,
          name: "TEST Dashboard Active Restaurant",
          subscriptionStatus: "active",
          planKey,
          isActive: true,
        },
        {
          slug: `test-dash-pastdue-${suffix}`,
          name: "TEST Dashboard Past Due Restaurant",
          subscriptionStatus: "past_due",
          planKey,
          isActive: true,
        },
      ])
      .returning({ id: schema.restaurants.id });
    restaurantActiveId = active.id;
    restaurantPastDueId = pastDue.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantActiveId, name: "TEST Dashboard Branch", isMain: true, isActive: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Dashboard User", phone: `9795${suffix.slice(0, 6)}`, passwordHash: "x", isActive: true })
      .returning({ id: schema.users.id });
    userId = user.id;

    // One order "today" (relative to `now`), one order last month (outside
    // "this month"'s UTC-calendar-month window).
    await db.insert(schema.orders).values([
      {
        restaurantId: restaurantActiveId,
        branchId,
        orderNumber: `TEST-DASH-${suffix}-1`,
        subtotalInPaisa: 1000,
        taxInPaisa: 0,
        totalInPaisa: 1000,
        createdAt: now,
      },
      {
        restaurantId: restaurantActiveId,
        branchId,
        orderNumber: `TEST-DASH-${suffix}-2`,
        subtotalInPaisa: 1000,
        taxInPaisa: 0,
        totalInPaisa: 1000,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);

    featureFlagKey = `test_dashboard_flag_${suffix}`;
    await db.insert(schema.featureFlags).values({
      key: featureFlagKey,
      name: "TEST Dashboard Flag",
      description: "A test feature flag for dashboard metrics.",
      defaultEnabled: false,
    });
    await db.insert(schema.entitlementOverrides).values({
      restaurantId: restaurantActiveId,
      featureKey: featureFlagKey,
      granted: true,
      reason: "TEST override for dashboard metrics",
      createdByUserId: userId,
    });
  });

  afterAll(async () => {
    const restaurantIds = [restaurantActiveId, restaurantPastDueId];
    await db.delete(schema.entitlementOverrides).where(inArray(schema.entitlementOverrides.restaurantId, restaurantIds));
    await db.delete(schema.featureFlags).where(eq(schema.featureFlags.key, featureFlagKey));
    await db.delete(schema.orders).where(inArray(schema.orders.restaurantId, restaurantIds));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantActiveId));
    await db.delete(schema.restaurants).where(inArray(schema.restaurants.id, restaurantIds));
    await db.delete(schema.plans).where(eq(schema.plans.key, planKey));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("counts users, branches, and orders (today/this month) at least including our seeded rows", async () => {
    const metrics = await dashboardMetricsDb.getDashboardMetrics(now);
    expect(metrics.users.total).toBeGreaterThanOrEqual(1);
    expect(metrics.branches.total).toBeGreaterThanOrEqual(1);
    expect(metrics.branches.active).toBeGreaterThanOrEqual(1);
    // Both our seeded orders fall in "this month" (June 2026) except the
    // May one, so thisMonth counts at least the 1 June order and today
    // counts exactly that same one (createdAt === now, same UTC day).
    expect(metrics.orders.today).toBeGreaterThanOrEqual(1);
    expect(metrics.orders.thisMonth).toBeGreaterThanOrEqual(1);
  });

  it("sums subscription revenue for active vs past_due restaurants separately, using each restaurant's effective plan price", async () => {
    const metrics = await dashboardMetricsDb.getDashboardMetrics(now);
    // Both our restaurants are on the same Rs 2,500/mo plan; active revenue
    // must include at least our one active restaurant's price, and
    // past-due revenue must include at least our one past-due restaurant's
    // price — as a strict lower bound, since other seed data may exist.
    expect(metrics.revenue.activeMonthlyInPaisa).toBeGreaterThanOrEqual(250_000);
    expect(metrics.revenue.pastDueMonthlyInPaisa).toBeGreaterThanOrEqual(250_000);
  });

  it("reports plan distribution including our test plan's restaurant count", async () => {
    const metrics = await dashboardMetricsDb.getDashboardMetrics(now);
    const row = metrics.planDistribution.find((p) => p.planKey === planKey);
    expect(row).toBeDefined();
    expect(row?.restaurantCount).toBe(2);
    expect(row?.planName).toBe("TEST Dashboard Plan");
  });

  it("reports feature usage: plan-derived count for the plan's featureKeys entry, override count for the flag", async () => {
    const metrics = await dashboardMetricsDb.getDashboardMetrics(now);

    const planFeature = metrics.featureUsage.find((f) => f.featureKey === "test_dashboard_feature");
    expect(planFeature).toBeDefined();
    // Both our restaurants are on the plan that includes this key.
    expect(planFeature?.viaPlanCount).toBeGreaterThanOrEqual(2);

    const flagFeature = metrics.featureUsage.find((f) => f.featureKey === featureFlagKey);
    expect(flagFeature).toBeDefined();
    expect(flagFeature?.defaultEnabled).toBe(false);
    expect(flagFeature?.overrideGrantedCount).toBe(1);
    expect(flagFeature?.overrideRevokedCount).toBe(0);
    expect(flagFeature?.viaPlanCount).toBe(0);
  });
});
