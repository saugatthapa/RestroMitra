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

  // Phase 17 (Attendance overhaul, Track B — plan-gated attendance tiers)
  // — requireFeature() is the assert-style sibling of hasFeature() that
  // resolveRestaurantContext's opts.requireFeature actually calls (see
  // api-route-helpers.ts). This restaurant's test plan only carries
  // "pos_billing", so "staff_attendance" is a clean not-entitled case.
  describe("requireFeature", () => {
    it("resolves silently when the restaurant is entitled", async () => {
      await expect(entitlementsDb.requireFeature(restaurantId, "pos_billing")).resolves.toBeUndefined();
    });

    it("throws FeatureNotEntitledError (a 403 HttpError) when the restaurant is not entitled", async () => {
      await expect(entitlementsDb.requireFeature(restaurantId, "staff_attendance")).rejects.toThrow(
        entitlementsDb.FeatureNotEntitledError,
      );
      try {
        await entitlementsDb.requireFeature(restaurantId, "staff_attendance");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(entitlementsDb.FeatureNotEntitledError);
        const typed = err as InstanceType<typeof entitlementsDb.FeatureNotEntitledError>;
        expect(typed.status).toBe(403);
        expect(typed.featureKey).toBe("staff_attendance");
      }
    });

    it("respects an entitlement override the same way hasFeature does", async () => {
      await entitlementsDb.setEntitlementOverride({
        restaurantId,
        featureKey: "staff_attendance",
        granted: true,
        reason: "Phase 17 test — override grant.",
        createdByUserId: ownerUserId,
      });
      await expect(entitlementsDb.requireFeature(restaurantId, "staff_attendance")).resolves.toBeUndefined();
      await entitlementsDb.clearEntitlementOverride(restaurantId, "staff_attendance");
    });
  });

  // Phase 17 — a regression test against the REAL seeded plan catalog
  // (not a synthetic test plan), proving drizzle/0066's data migration
  // actually landed: Growth and Pro carry the new staff_attendance key
  // (same tier as payroll), Starter deliberately does not.
  describe("staff_attendance plan gating (real catalog, Phase 17 / drizzle 0066)", () => {
    it("Growth and Pro both include staff_attendance", async () => {
      const plansDb = await import("@/lib/plans-db");
      const growth = await plansDb.getPlanByKey("growth");
      const pro = await plansDb.getPlanByKey("pro");
      expect(growth?.featureKeys).toContain("staff_attendance");
      expect(pro?.featureKeys).toContain("staff_attendance");
    });

    it("Starter does NOT include staff_attendance", async () => {
      const plansDb = await import("@/lib/plans-db");
      const starter = await plansDb.getPlanByKey("starter");
      expect(starter?.featureKeys).not.toContain("staff_attendance");
    });

    it("a Starter-plan restaurant is not entitled to staff_attendance; a Growth-plan restaurant is", async () => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const [starterRestaurant] = await db
        .insert(schema.restaurants)
        .values({ slug: `test-ent-starter-${suffix}`, name: "TEST Starter Restaurant", planKey: "starter", isActive: true })
        .returning({ id: schema.restaurants.id });
      const [growthRestaurant] = await db
        .insert(schema.restaurants)
        .values({ slug: `test-ent-growth-${suffix}`, name: "TEST Growth Restaurant", planKey: "growth", isActive: true })
        .returning({ id: schema.restaurants.id });

      try {
        expect(await entitlementsDb.hasFeature(starterRestaurant.id, "staff_attendance")).toBe(false);
        expect(await entitlementsDb.hasFeature(growthRestaurant.id, "staff_attendance")).toBe(true);
      } finally {
        await db.delete(schema.restaurants).where(eq(schema.restaurants.id, starterRestaurant.id));
        await db.delete(schema.restaurants).where(eq(schema.restaurants.id, growthRestaurant.id));
      }
    });
  });

  // Phase 11 security pass — the audit flagged that no test proved an
  // override set for one restaurant can't leak onto a different one, even
  // though a reading of setEntitlementOverride/getEntitlementOverridesFor
  // Restaurant/hasFeature (all scoped by a restaurantId column/parameter,
  // no shared cache keyed only by featureKey) suggested it was already
  // correctly isolated. This locks that in as a regression test rather
  // than an unverified reading of the code.
  describe("cross-tenant override isolation", () => {
    let restaurantBId: string;
    let ownerBUserId: string;

    beforeAll(async () => {
      const suffixB = Math.random().toString(36).slice(2, 8);
      const [userB] = await db
        .insert(schema.users)
        .values({
          fullName: "TEST Entitlement Admin B",
          phone: `9749${suffixB.slice(0, 6)}`,
          passwordHash: "x",
        })
        .returning({ id: schema.users.id });
      ownerBUserId = userB.id;

      const [restaurantB] = await db
        .insert(schema.restaurants)
        .values({
          slug: `test-ent-b-${suffixB}`,
          name: "TEST Entitlement Restaurant B",
          subscriptionStatus: "active",
          planKey, // same plan as restaurant A — proves isolation isn't just "different plan"
          isActive: true,
        })
        .returning({ id: schema.restaurants.id });
      restaurantBId = restaurantB.id;
    });

    afterAll(async () => {
      await db.delete(schema.entitlementOverrides).where(eq(schema.entitlementOverrides.restaurantId, restaurantBId));
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerBUserId));
    });

    it("a deny override on restaurant A does not affect restaurant B's access to the same feature", async () => {
      // pos_billing is in the shared plan's featureKeys, so both start granted.
      expect(await entitlementsDb.hasFeature(restaurantId, "pos_billing")).toBe(true);
      expect(await entitlementsDb.hasFeature(restaurantBId, "pos_billing")).toBe(true);

      await entitlementsDb.setEntitlementOverride({
        restaurantId,
        featureKey: "pos_billing",
        granted: false,
        reason: "Cross-tenant isolation test — deny A only.",
        createdByUserId: ownerUserId,
      });

      expect(await entitlementsDb.hasFeature(restaurantId, "pos_billing")).toBe(false);
      expect(await entitlementsDb.hasFeature(restaurantBId, "pos_billing")).toBe(true); // unaffected

      const explainedB = await entitlementsDb.explainTenantAccess(restaurantBId);
      const posBillingB = explainedB.find((e) => e.featureKey === "pos_billing");
      expect(posBillingB).toMatchObject({ granted: true, source: "plan" }); // still "plan", not "override"

      // Restore A for cleanliness (afterAll on the outer describe also
      // deletes A's override rows, but explicit is cheap and self-documenting).
      await entitlementsDb.clearEntitlementOverride(restaurantId, "pos_billing");
    });

    it("a grant override on restaurant B for a key neither plan carries does not leak a grant onto A", async () => {
      expect(await entitlementsDb.hasFeature(restaurantId, "reservations")).toBe(false);
      expect(await entitlementsDb.hasFeature(restaurantBId, "reservations")).toBe(false);

      await entitlementsDb.setEntitlementOverride({
        restaurantId: restaurantBId,
        featureKey: "reservations",
        granted: true,
        reason: "Cross-tenant isolation test — grant B only.",
        createdByUserId: ownerBUserId,
      });

      expect(await entitlementsDb.hasFeature(restaurantBId, "reservations")).toBe(true);
      expect(await entitlementsDb.hasFeature(restaurantId, "reservations")).toBe(false); // unaffected

      const overridesForA = await entitlementsDb.getEntitlementOverridesForRestaurant(restaurantId);
      expect(overridesForA.find((o) => o.featureKey === "reservations")).toBeUndefined();
    });
  });
});
