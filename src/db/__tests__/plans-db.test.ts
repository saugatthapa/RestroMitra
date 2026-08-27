/**
 * Platform Control Center, Phase 4 — integration test for the DB-backed
 * plan catalog (src/lib/plans-db.ts). Skipped (not failed) when
 * DATABASE_URL isn't set, same convention as the other DB-backed
 * integration tests in this project (see tenant-suspension.test.ts).
 *
 * Uses temporary TEST_ prefixed plan rows rather than the real seeded
 * starter/growth/pro plans, so these tests never depend on (or risk
 * corrupting) the live catalog's actual values.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("plans-db (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let plansDb: typeof import("@/lib/plans-db");
  let plansPure: typeof import("@/lib/plans");

  let activeKey: string;
  let retiredKey: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    plansDb = await import("@/lib/plans-db");
    plansPure = await import("@/lib/plans");

    const suffix = Math.random().toString(36).slice(2, 8);
    activeKey = `test-active-${suffix}`;
    retiredKey = `test-retired-${suffix}`;

    await db.insert(schema.plans).values([
      {
        key: activeKey,
        name: "TEST Active Plan",
        tagline: "An active test plan.",
        priceInPaisaMonthly: 100_000,
        maxStaff: 5,
        maxBranches: 1,
        highlight: false,
        features: ["Feature A"],
        featureKeys: ["pos_billing"],
        sortOrder: 500,
        isActive: true,
      },
      {
        key: retiredKey,
        name: "TEST Retired Plan",
        tagline: "A retired test plan.",
        priceInPaisaMonthly: 200_000,
        maxStaff: null,
        maxBranches: null,
        highlight: false,
        features: ["Feature B"],
        featureKeys: [],
        sortOrder: 501,
        isActive: false,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.plans).where(eq(schema.plans.key, activeKey));
    await db.delete(schema.plans).where(eq(schema.plans.key, retiredKey));
  });

  it("getActivePlans includes the active test plan but not the retired one", async () => {
    const active = await plansDb.getActivePlans();
    expect(active.some((p) => p.key === activeKey)).toBe(true);
    expect(active.some((p) => p.key === retiredKey)).toBe(false);
  });

  it("getAllPlansForAdmin includes both", async () => {
    const all = await plansDb.getAllPlansForAdmin();
    expect(all.some((p) => p.key === activeKey)).toBe(true);
    expect(all.some((p) => p.key === retiredKey)).toBe(true);
  });

  it("getPlanByKey resolves a retired plan too — isActive only filters listings, never lookup", async () => {
    const plan = await plansDb.getPlanByKey(retiredKey);
    expect(plan?.name).toBe("TEST Retired Plan");
  });

  it("getPlanByKey returns null for null/undefined/unknown keys", async () => {
    expect(await plansDb.getPlanByKey(null)).toBeNull();
    expect(await plansDb.getPlanByKey(undefined)).toBeNull();
    expect(await plansDb.getPlanByKey("not-a-real-plan")).toBeNull();
  });

  it("getEffectivePlan returns the catalog plan unchanged when no price is locked", async () => {
    const effective = await plansDb.getEffectivePlan({
      planKey: activeKey,
      lockedMonthlyPriceInPaisa: null,
    });
    expect(effective?.priceInPaisaMonthly).toBe(100_000);
  });

  it("getEffectivePlan overrides only the price when a lock is set", async () => {
    const effective = await plansDb.getEffectivePlan({
      planKey: activeKey,
      lockedMonthlyPriceInPaisa: 179_900,
    });
    expect(effective?.priceInPaisaMonthly).toBe(179_900);
    expect(effective?.name).toBe("TEST Active Plan");
  });

  it("getEffectivePlan returns null for an unassigned plan regardless of any lock", async () => {
    const effective = await plansDb.getEffectivePlan({
      planKey: null,
      lockedMonthlyPriceInPaisa: 179_900,
    });
    expect(effective).toBeNull();
  });

  it("maxStaffForRestaurant returns the trial default when no plan is assigned", async () => {
    expect(await plansDb.maxStaffForRestaurant({ planKey: null })).toBe(plansPure.TRIAL_MAX_STAFF);
  });

  it("maxStaffForRestaurant returns the assigned plan's own limit", async () => {
    expect(await plansDb.maxStaffForRestaurant({ planKey: activeKey })).toBe(5);
  });

  it("maxStaffForRestaurant returns null (unlimited) for a null-maxStaff plan", async () => {
    expect(await plansDb.maxStaffForRestaurant({ planKey: retiredKey })).toBeNull();
  });

  it("maxBranchesForRestaurant returns the assigned plan's own limit", async () => {
    expect(await plansDb.maxBranchesForRestaurant({ planKey: activeKey })).toBe(1);
  });

  it("maxBranchesForRestaurant returns null (unlimited) for a null-maxBranches plan", async () => {
    expect(await plansDb.maxBranchesForRestaurant({ planKey: retiredKey })).toBeNull();
  });
});
