import { describe, it, expect } from "vitest";
import {
  PLANS,
  PLAN_MAP,
  getPlanByKey,
  getEffectivePlan,
  maxStaffForRestaurant,
  TRIAL_MAX_STAFF,
  maxBranchesForRestaurant,
  TRIAL_MAX_BRANCHES,
  yearlyPriceInPaisa,
  monthlyEquivalentWhenYearlyInPaisa,
} from "./plans";

describe("PLANS catalog", () => {
  it("has exactly one entry per PLAN_MAP key, all priced positively", () => {
    expect(PLANS.length).toBe(Object.keys(PLAN_MAP).length);
    for (const plan of PLANS) {
      expect(plan.priceInPaisaMonthly).toBeGreaterThan(0);
      expect(PLAN_MAP[plan.key]).toBe(plan);
    }
  });

  it("prices strictly increase from starter to growth to pro", () => {
    const [starter, growth, pro] = PLANS;
    expect(growth.priceInPaisaMonthly).toBeGreaterThan(starter.priceInPaisaMonthly);
    expect(pro.priceInPaisaMonthly).toBeGreaterThan(growth.priceInPaisaMonthly);
  });

  it("the top plan is unlimited staff (null), lower plans have a numeric cap", () => {
    const pro = PLAN_MAP.pro;
    expect(pro.maxStaff).toBeNull();
    expect(PLAN_MAP.starter.maxStaff).toBeGreaterThan(0);
    expect(PLAN_MAP.growth.maxStaff).toBeGreaterThan(PLAN_MAP.starter.maxStaff!);
  });

  it("the top plan is unlimited branches (null), lower plans have a numeric cap", () => {
    expect(PLAN_MAP.pro.maxBranches).toBeNull();
    expect(PLAN_MAP.starter.maxBranches).toBeGreaterThan(0);
    expect(PLAN_MAP.growth.maxBranches).toBeGreaterThan(PLAN_MAP.starter.maxBranches!);
  });
});

describe("yearlyPriceInPaisa", () => {
  it("is exactly 10x the monthly price for every plan (2 months free)", () => {
    for (const plan of PLANS) {
      expect(yearlyPriceInPaisa(plan)).toBe(plan.priceInPaisaMonthly * 10);
    }
  });

  it("is always cheaper than paying monthly for 12 months", () => {
    for (const plan of PLANS) {
      expect(yearlyPriceInPaisa(plan)).toBeLessThan(plan.priceInPaisaMonthly * 12);
    }
  });
});

describe("monthlyEquivalentWhenYearlyInPaisa", () => {
  it("is lower than the plan's own monthly price (that's the point of billing yearly)", () => {
    for (const plan of PLANS) {
      expect(monthlyEquivalentWhenYearlyInPaisa(plan)).toBeLessThan(plan.priceInPaisaMonthly);
    }
  });

  it("rounds yearly/12 to the nearest paisa", () => {
    const starter = PLAN_MAP.starter;
    expect(monthlyEquivalentWhenYearlyInPaisa(starter)).toBe(
      Math.round(yearlyPriceInPaisa(starter) / 12),
    );
  });
});

describe("getPlanByKey", () => {
  it("returns the matching plan for a known key", () => {
    expect(getPlanByKey("growth")?.name).toBe("Growth");
  });

  it("returns null for null/undefined/unknown keys", () => {
    expect(getPlanByKey(null)).toBeNull();
    expect(getPlanByKey(undefined)).toBeNull();
    expect(getPlanByKey("not-a-real-plan")).toBeNull();
  });
});

describe("getEffectivePlan", () => {
  it("returns the catalog plan unchanged when no price is locked", () => {
    const effective = getEffectivePlan({ planKey: "growth", lockedMonthlyPriceInPaisa: null });
    expect(effective?.priceInPaisaMonthly).toBe(PLAN_MAP.growth.priceInPaisaMonthly);
  });

  it("overrides only the price when a lock is set, keeping every other field", () => {
    const effective = getEffectivePlan({ planKey: "growth", lockedMonthlyPriceInPaisa: 179_900 });
    expect(effective?.priceInPaisaMonthly).toBe(179_900);
    expect(effective?.name).toBe(PLAN_MAP.growth.name);
    expect(effective?.features).toEqual(PLAN_MAP.growth.features);
    expect(effective?.maxStaff).toBe(PLAN_MAP.growth.maxStaff);
  });

  it("downstream price helpers respect the lock automatically", () => {
    const effective = getEffectivePlan({ planKey: "growth", lockedMonthlyPriceInPaisa: 179_900 });
    expect(yearlyPriceInPaisa(effective!)).toBe(1_799_000);
  });

  it("returns null for an unassigned/unknown plan regardless of any lock", () => {
    expect(getEffectivePlan({ planKey: null, lockedMonthlyPriceInPaisa: 179_900 })).toBeNull();
  });
});

describe("maxStaffForRestaurant", () => {
  it("returns the generous trial default when no plan is assigned", () => {
    expect(maxStaffForRestaurant({ planKey: null })).toBe(TRIAL_MAX_STAFF);
  });

  it("returns the assigned plan's own limit", () => {
    expect(maxStaffForRestaurant({ planKey: "starter" })).toBe(PLAN_MAP.starter.maxStaff);
  });

  it("returns null (unlimited) for the pro plan", () => {
    expect(maxStaffForRestaurant({ planKey: "pro" })).toBeNull();
  });

  it("falls back to the trial default for an unrecognized plan key", () => {
    expect(maxStaffForRestaurant({ planKey: "not-a-real-plan" })).toBe(TRIAL_MAX_STAFF);
  });
});

describe("maxBranchesForRestaurant", () => {
  it("returns the trial default when no plan is assigned", () => {
    expect(maxBranchesForRestaurant({ planKey: null })).toBe(TRIAL_MAX_BRANCHES);
  });

  it("returns the assigned plan's own limit", () => {
    expect(maxBranchesForRestaurant({ planKey: "starter" })).toBe(PLAN_MAP.starter.maxBranches);
    expect(maxBranchesForRestaurant({ planKey: "growth" })).toBe(PLAN_MAP.growth.maxBranches);
  });

  it("returns null (unlimited) for the pro plan", () => {
    expect(maxBranchesForRestaurant({ planKey: "pro" })).toBeNull();
  });

  it("falls back to the trial default for an unrecognized plan key", () => {
    expect(maxBranchesForRestaurant({ planKey: "not-a-real-plan" })).toBe(TRIAL_MAX_BRANCHES);
  });
});
