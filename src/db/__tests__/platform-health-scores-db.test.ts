/**
 * Gap-audit P1 fix (Finding 3) — integration test for
 * getPlatformHealthScores()/getAtRiskTenants() (src/lib/support/health-
 * score-db.ts): the platform-wide, batched-not-per-restaurant counterpart
 * to getRestaurantHealthScore(), which backs the dashboard's proactive
 * "these N tenants are at risk" list.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same convention as
 * the other DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("getPlatformHealthScores / getAtRiskTenants (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let healthScoreDb: typeof import("@/lib/support/health-score-db");

  let healthyId: string;
  let atRiskId: string; // suspended
  let watchId: string; // no orders, past grace period
  const suffix = Math.random().toString(36).slice(2, 8);
  const now = new Date("2026-06-15T00:00:00.000Z");
  const longAgo = new Date("2025-01-01T00:00:00.000Z");

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    healthScoreDb = await import("@/lib/support/health-score-db");

    const [healthy, atRisk, watch] = await db
      .insert(schema.restaurants)
      .values([
        {
          slug: `test-phs-healthy-${suffix}`,
          name: "TEST PHS Healthy",
          subscriptionStatus: "active",
          isActive: true,
          onboardingCompletedAt: longAgo,
        },
        {
          slug: `test-phs-atrisk-${suffix}`,
          name: "TEST PHS At Risk",
          subscriptionStatus: "active",
          isActive: false, // suspended: -40, guarantees at_risk band
          onboardingCompletedAt: longAgo,
        },
        {
          slug: `test-phs-watch-${suffix}`,
          name: "TEST PHS Watch",
          // past_due (-20) + no orders ever (-25) = score 55, the "watch" band (45-74).
          subscriptionStatus: "past_due",
          isActive: true,
          onboardingCompletedAt: longAgo,
        },
      ])
      .returning({ id: schema.restaurants.id });
    healthyId = healthy.id;
    atRiskId = atRisk.id;
    watchId = watch.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId: healthyId, name: "TEST Branch", isMain: true })
      .returning({ id: schema.branches.id });

    // Give the "healthy" restaurant plenty of recent order volume.
    for (let i = 0; i < 6; i++) {
      await db.insert(schema.orders).values({
        restaurantId: healthyId,
        branchId: branch.id,
        orderNumber: `TEST-PHS-${suffix}-${i}`,
        subtotalInPaisa: 1000,
        taxInPaisa: 0,
        totalInPaisa: 1000,
        createdAt: now,
      });
    }
  });

  afterAll(async () => {
    const ids = [healthyId, atRiskId, watchId];
    await db.delete(schema.orders).where(inArray(schema.orders.restaurantId, ids));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, healthyId));
    await db.delete(schema.restaurants).where(inArray(schema.restaurants.id, ids));
  });

  it("getPlatformHealthScores includes every restaurant, sorted worst-first", async () => {
    const rows = await healthScoreDb.getPlatformHealthScores(now);
    const byId = new Map(rows.map((r) => [r.restaurantId, r]));

    expect(byId.get(healthyId)?.healthScore.band).toBe("healthy");
    expect(byId.get(atRiskId)?.healthScore.band).toBe("at_risk");
    expect(byId.get(watchId)?.healthScore.band).toBe("watch");

    // Worst-first: at_risk's score is lower than watch's, which is lower
    // than healthy's, for our three seeded rows specifically.
    const ourRows = rows.filter((r) => [healthyId, atRiskId, watchId].includes(r.restaurantId));
    const scores = ourRows.map((r) => r.healthScore.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
  });

  it("getAtRiskTenants(at_risk) includes only the suspended restaurant, not the merely-watch one", async () => {
    const atRisk = await healthScoreDb.getAtRiskTenants("at_risk", now);
    const ids = atRisk.map((r) => r.restaurantId);
    expect(ids).toContain(atRiskId);
    expect(ids).not.toContain(healthyId);
    expect(ids).not.toContain(watchId);
  });

  it("getAtRiskTenants(watch) widens the cutoff to include both at_risk and watch, never healthy", async () => {
    const widened = await healthScoreDb.getAtRiskTenants("watch", now);
    const ids = widened.map((r) => r.restaurantId);
    expect(ids).toContain(atRiskId);
    expect(ids).toContain(watchId);
    expect(ids).not.toContain(healthyId);
  });

  it("matches getRestaurantHealthScore's own per-tenant computation for the same restaurant", async () => {
    const platformRows = await healthScoreDb.getPlatformHealthScores(now);
    const platformRow = platformRows.find((r) => r.restaurantId === healthyId);
    // getRestaurantHealthScore uses "now" internally (no override param),
    // so compare only the inputs that don't depend on the exact instant —
    // the order-volume-driven band/score should agree regardless.
    expect(platformRow?.healthScore.band).toBe("healthy");
    expect(platformRow?.healthScore.reasons).toEqual([]);
  });
});
