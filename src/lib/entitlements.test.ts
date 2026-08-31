import { describe, it, expect } from "vitest";
import { resolveFeatureAccess } from "./entitlements";

describe("resolveFeatureAccess", () => {
  it("grants via plan when the key is in planFeatureKeys and nothing else applies", () => {
    const result = resolveFeatureAccess("inventory", { planFeatureKeys: ["inventory", "reports"] });
    expect(result).toEqual({ featureKey: "inventory", granted: true, source: "plan" });
  });

  it("denies (source: none) when nothing grants it", () => {
    const result = resolveFeatureAccess("reservations", { planFeatureKeys: ["pos_billing"] });
    expect(result).toEqual({ featureKey: "reservations", granted: false, source: "none" });
  });

  it("falls back to the feature flag default when the plan doesn't include the key", () => {
    const result = resolveFeatureAccess("ai_assistant_v2_beta", {
      planFeatureKeys: ["pos_billing"],
      flagDefault: true,
    });
    expect(result).toEqual({ featureKey: "ai_assistant_v2_beta", granted: true, source: "flag" });
  });

  it("a false flag default denies with source flag, distinct from no flag at all", () => {
    const result = resolveFeatureAccess("ai_assistant_v2_beta", {
      planFeatureKeys: [],
      flagDefault: false,
    });
    expect(result).toEqual({ featureKey: "ai_assistant_v2_beta", granted: false, source: "flag" });
  });

  it("an override wins over the plan even when the plan already includes the key", () => {
    const result = resolveFeatureAccess("inventory", {
      planFeatureKeys: ["inventory"],
      override: false,
    });
    expect(result).toEqual({ featureKey: "inventory", granted: false, source: "override" });
  });

  it("an override wins over the flag default", () => {
    const result = resolveFeatureAccess("ai_assistant_v2_beta", {
      planFeatureKeys: [],
      flagDefault: false,
      override: true,
    });
    expect(result).toEqual({ featureKey: "ai_assistant_v2_beta", granted: true, source: "override" });
  });

  it("an override wins over both plan and flag when all three are present", () => {
    const result = resolveFeatureAccess("inventory", {
      planFeatureKeys: ["inventory"],
      flagDefault: true,
      override: false,
    });
    expect(result.source).toBe("override");
    expect(result.granted).toBe(false);
  });

  it("a false plan lookup miss combined with a false override is still an explicit override, not none", () => {
    // Regression guard: override:false must be distinguished from
    // override:undefined — a naive `if (override)` check would treat a
    // deliberate revocation as "no override," and this would silently fall
    // through to plan/flag/none instead of staying denied.
    const result = resolveFeatureAccess("pos_billing", {
      planFeatureKeys: ["pos_billing"],
      override: false,
    });
    expect(result).toEqual({ featureKey: "pos_billing", granted: false, source: "override" });
  });

  it("null override/flagDefault are treated the same as undefined (no override / no flag)", () => {
    const result = resolveFeatureAccess("pos_billing", {
      planFeatureKeys: ["pos_billing"],
      override: null,
      flagDefault: null,
    });
    expect(result).toEqual({ featureKey: "pos_billing", granted: true, source: "plan" });
  });
});
