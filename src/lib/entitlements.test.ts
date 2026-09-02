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

  describe("override expiry", () => {
    it("an override with a past expiresAt is not active — falls back to the plan default, same as a manually revoked override", () => {
      const now = new Date("2026-06-15T00:00:00Z");
      const result = resolveFeatureAccess(
        "inventory",
        {
          planFeatureKeys: ["inventory"],
          override: false, // would otherwise force-deny a plan-granted key
          overrideExpiresAt: new Date("2026-06-01T00:00:00Z"),
        },
        now,
      );
      expect(result).toEqual({ featureKey: "inventory", granted: true, source: "plan" });
    });

    it("an expired override falls all the way through to flag/none when the plan doesn't cover the key either", () => {
      const now = new Date("2026-06-15T00:00:00Z");
      const result = resolveFeatureAccess(
        "ai_assistant_v2_beta",
        {
          planFeatureKeys: [],
          override: true,
          overrideExpiresAt: new Date("2026-01-01T00:00:00Z"),
        },
        now,
      );
      expect(result).toEqual({ featureKey: "ai_assistant_v2_beta", granted: false, source: "none" });
    });

    it("an override with a future expiresAt is still active, and echoes the expiry back on the result", () => {
      const now = new Date("2026-06-15T00:00:00Z");
      const expiresAt = new Date("2026-12-31T23:59:59.999Z");
      const result = resolveFeatureAccess(
        "inventory",
        { planFeatureKeys: [], override: true, overrideExpiresAt: expiresAt },
        now,
      );
      expect(result).toEqual({ featureKey: "inventory", granted: true, source: "override", expiresAt });
    });

    it("a null expiresAt (no expiry) is permanent — the historical default, preserved for overrides that never set one", () => {
      const result = resolveFeatureAccess("inventory", {
        planFeatureKeys: [],
        override: true,
        overrideExpiresAt: null,
      });
      expect(result).toEqual({ featureKey: "inventory", granted: true, source: "override", expiresAt: null });
    });

    it("an override expiring at exactly `now` is treated as already expired (inclusive boundary)", () => {
      const now = new Date("2026-06-15T00:00:00Z");
      const result = resolveFeatureAccess(
        "inventory",
        { planFeatureKeys: ["inventory"], override: false, overrideExpiresAt: now },
        now,
      );
      expect(result.source).toBe("plan");
    });
  });
});
