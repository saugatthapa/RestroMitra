import { describe, it, expect } from "vitest";
import { yearlyPriceInPaisa, monthlyEquivalentWhenYearlyInPaisa, applyPriceLock, type Plan } from "./plans";

// Phase 4 — plans.ts is now pure types/math only (the actual catalog moved
// to the DB-backed `plans` table; see plans-db.ts and its own integration
// test, src/db/__tests__/plans-db.test.ts). These tests use inline mock
// Plan objects rather than a real catalog, since this module can no longer
// see one.

function mockPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    key: "test-plan",
    name: "Test Plan",
    tagline: "A plan for testing.",
    priceInPaisaMonthly: 100_000,
    maxStaff: 10,
    maxBranches: 2,
    highlight: false,
    features: ["Feature A", "Feature B"],
    featureKeys: ["pos_billing"],
    sortOrder: 0,
    isActive: true,
    ...overrides,
  };
}

describe("yearlyPriceInPaisa", () => {
  it("is exactly 10x the monthly price (2 months free)", () => {
    const plan = mockPlan({ priceInPaisaMonthly: 79_900 });
    expect(yearlyPriceInPaisa(plan)).toBe(799_000);
  });

  it("is always cheaper than paying monthly for 12 months", () => {
    const plan = mockPlan({ priceInPaisaMonthly: 139_900 });
    expect(yearlyPriceInPaisa(plan)).toBeLessThan(plan.priceInPaisaMonthly * 12);
  });
});

describe("monthlyEquivalentWhenYearlyInPaisa", () => {
  it("is lower than the plan's own monthly price (that's the point of billing yearly)", () => {
    const plan = mockPlan({ priceInPaisaMonthly: 79_900 });
    expect(monthlyEquivalentWhenYearlyInPaisa(plan)).toBeLessThan(plan.priceInPaisaMonthly);
  });

  it("rounds yearly/12 to the nearest paisa", () => {
    const plan = mockPlan({ priceInPaisaMonthly: 79_900 });
    expect(monthlyEquivalentWhenYearlyInPaisa(plan)).toBe(Math.round(yearlyPriceInPaisa(plan) / 12));
  });
});

describe("applyPriceLock", () => {
  it("returns the plan unchanged when no lock is set", () => {
    const plan = mockPlan({ priceInPaisaMonthly: 139_900 });
    expect(applyPriceLock(plan, null)).toBe(plan);
    expect(applyPriceLock(plan, undefined)).toBe(plan);
  });

  it("overrides only the price when a lock is set, keeping every other field", () => {
    const plan = mockPlan({ priceInPaisaMonthly: 139_900 });
    const locked = applyPriceLock(plan, 179_900);
    expect(locked.priceInPaisaMonthly).toBe(179_900);
    expect(locked.name).toBe(plan.name);
    expect(locked.features).toEqual(plan.features);
    expect(locked.maxStaff).toBe(plan.maxStaff);
  });

  it("downstream price helpers respect the lock automatically", () => {
    const plan = mockPlan({ priceInPaisaMonthly: 139_900 });
    const locked = applyPriceLock(plan, 179_900);
    expect(yearlyPriceInPaisa(locked)).toBe(1_799_000);
  });
});
