import { describe, it, expect } from "vitest";
import {
  PLANS,
  PLAN_MAP,
  getPlanByKey,
  maxStaffForRestaurant,
  TRIAL_MAX_STAFF,
  maxBranchesForRestaurant,
  TRIAL_MAX_BRANCHES,
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
