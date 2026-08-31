/**
 * Platform Control Center, Phase 5 — integration test for the DB-backed
 * half of the entitlement engine (src/lib/entitlements-db.ts): feature
 * flags, per-tenant overrides, and explainTenantAccess()'s combination of
 * both with a restaurant's plan. Skipped (not failed) when DATABASE_URL
 * isn't set, same convention as the other DB-backed integration tests in
 * this project (see plans-db.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("entitlements-db (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let entitlementsDb: typeof import("@/lib/entitlements-db");

  let restaurantId: string;
  let ownerUserId: string;
  let planKey: string;
  let flagKey: string;
  const suffix = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    entitlementsDb = await import("@/lib/entitlements-db");

    planKey = `test-ent-plan-${suffix}`;
    flagKey = `test_ent_flag_${suffix}`;

    await db.insert(schema.plans).values({
      key: planKey,
      name: "TEST Entitlement Plan",
      tagline: "A test plan for the entitlement engine.",
      priceInPaisaMonthly: 100_000,
      maxStaff: 5,
      maxBranches: 1,
      highlight: false,
      features: [],
      featureKeys: ["pos_billing"],
      sortOrder: 999,
      isActive: true,
    });

    const [user] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Entitlement Admin",
        phone: `9748${suffix.slice(0, 6)}`,
        passwordHash: "x",
      })
      .returning({ id: schema.users.id });
    ownerUserId = user.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-ent-${suffix}`,
        name: "TEST Entitlement Restaurant",
        subscriptionStatus: "active",
        planKey,
        isActive: true,
      })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;
  });

  afterAll(async () => {
    await db.delete(schema.entitlementOverrides).where(eq(schema.entitlementOverrides.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.featureFlags).where(eq(schema.featureFlags.key, flagKey));
    await db.delete(schema.plans).where(eq(schema.plans.key, planKey));
  });

  it("hasFeature is granted (source: plan) for a key already in the restaurant's plan", async () => {
    expect(await entitlementsDb.hasFeature(restaurantId, "pos_billing")).toBe(true);
  });

  it("hasFeature is denied for a key in neither the plan, a flag, nor an override", async () => {
    expect(await entitlementsDb.hasFeature(restaurantId, "reservations")).toBe(false);
  });

  it("a feature flag grants a key the plan doesn't include", async () => {
    await db.insert(schema.featureFlags).values({
      key: flagKey,
      name: "TEST Flag",
      description: "A test-only flag.",
      defaultEnabled: true,
    });
    expect(await entitlementsDb.hasFeature(restaurantId, flagKey)).toBe(true);
  });

  it("setEntitlementOverride forces a deny even though the plan grants the key, and explainTenantAccess reports source: override", async () => {
    await entitlementsDb.setEntitlementOverride({
      restaurantId,
      featureKey: "pos_billing",
      granted: false,
      reason: "Integration test override.",
      createdByUserId: ownerUserId,
    });
    expect(await entitlementsDb.hasFeature(restaurantId, "pos_billing")).toBe(false);

    const explained = await entitlementsDb.explainTenantAccess(restaurantId);
    const posBilling = explained.find((e) => e.featureKey === "pos_billing");
    expect(posBilling).toMatchObject({ granted: false, source: "override" });
  });

  it("setEntitlementOverride upserts — a second call for the same key replaces the first rather than duplicating", async () => {
    await entitlementsDb.setEntitlementOverride({
      restaurantId,
      featureKey: "pos_billing",
      granted: true,
      reason: "Reversing the override.",
      createdByUserId: ownerUserId,
    });
    const rows = await entitlementsDb.getEntitlementOverridesForRestaurant(restaurantId);
    const posBillingRows = rows.filter((r) => r.featureKey === "pos_billing");
    expect(posBillingRows).toHaveLength(1);
    expect(posBillingRows[0].granted).toBe(true);
  });

  it("clearEntitlementOverride removes the override and reverts to the plan/flag default", async () => {
    await entitlementsDb.clearEntitlementOverride(restaurantId, "pos_billing");
    const explained = await entitlementsDb.explainTenantAccess(restaurantId);
    const posBilling = explained.find((e) => e.featureKey === "pos_billing");
    expect(posBilling).toMatchObject({ granted: true, source: "plan" });
  });

  it("explainTenantAccess includes every FEATURES catalog key even with no override/flag for most of them", async () => {
    const explained = await entitlementsDb.explainTenantAccess(restaurantId);
    const keys = explained.map((e) => e.featureKey);
    expect(keys).toContain("reservations");
    expect(keys).toContain("multi_branch");
    const reservations = explained.find((e) => e.featureKey === "reservations");
    expect(reservations).toMatchObject({ granted: false, source: "none" });
  });
});
