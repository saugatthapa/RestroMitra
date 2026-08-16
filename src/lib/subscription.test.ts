import { describe, it, expect } from "vitest";
import { computeSubscriptionAccess, daysRemaining } from "./subscription";

const NOW = new Date("2026-08-14T12:00:00Z");

describe("computeSubscriptionAccess", () => {
  it("allows access when active", () => {
    expect(computeSubscriptionAccess({ subscriptionStatus: "active", trialEndsAt: null, now: NOW })).toEqual({
      allowed: true,
      reason: "active",
    });
  });

  it("allows access when past_due (grace period)", () => {
    expect(computeSubscriptionAccess({ subscriptionStatus: "past_due", trialEndsAt: null, now: NOW })).toEqual({
      allowed: true,
      reason: "past_due",
    });
  });

  it("allows access while trialing with a future trial end date", () => {
    const trialEndsAt = new Date("2026-08-20T00:00:00Z");
    expect(computeSubscriptionAccess({ subscriptionStatus: "trialing", trialEndsAt, now: NOW })).toEqual({
      allowed: true,
      reason: "trialing",
    });
  });

  it("allows access while trialing with no trial end date set", () => {
    expect(computeSubscriptionAccess({ subscriptionStatus: "trialing", trialEndsAt: null, now: NOW })).toEqual({
      allowed: true,
      reason: "trialing",
    });
  });

  it("blocks access once trialEndsAt is in the past", () => {
    const trialEndsAt = new Date("2026-08-01T00:00:00Z");
    expect(computeSubscriptionAccess({ subscriptionStatus: "trialing", trialEndsAt, now: NOW })).toEqual({
      allowed: false,
      reason: "trial_expired",
    });
  });

  it("blocks access exactly at the trial end instant (boundary is inclusive of expiry)", () => {
    expect(
      computeSubscriptionAccess({ subscriptionStatus: "trialing", trialEndsAt: NOW, now: NOW }),
    ).toEqual({ allowed: false, reason: "trial_expired" });
  });

  it("blocks access when cancelled", () => {
    expect(computeSubscriptionAccess({ subscriptionStatus: "cancelled", trialEndsAt: null, now: NOW })).toEqual({
      allowed: false,
      reason: "cancelled",
    });
  });

  it("blocks access when expired", () => {
    expect(computeSubscriptionAccess({ subscriptionStatus: "expired", trialEndsAt: null, now: NOW })).toEqual({
      allowed: false,
      reason: "expired",
    });
  });

  it("fails closed for an unrecognized status rather than defaulting open", () => {
    expect(
      computeSubscriptionAccess({ subscriptionStatus: "something_new", trialEndsAt: null, now: NOW }),
    ).toEqual({ allowed: false, reason: "expired" });
  });

  it("defaults `now` to the current time when omitted", () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    expect(computeSubscriptionAccess({ subscriptionStatus: "trialing", trialEndsAt: farFuture }).allowed).toBe(true);
  });
});

describe("daysRemaining", () => {
  it("returns null when there's no trial end date", () => {
    expect(daysRemaining(null, NOW)).toBeNull();
  });

  it("rounds up a partial day", () => {
    const trialEndsAt = new Date(NOW.getTime() + 1000 * 60 * 60 * 25); // 25 hours out
    expect(daysRemaining(trialEndsAt, NOW)).toBe(2);
  });

  it("returns 0, not negative, once the trial end date has passed", () => {
    const trialEndsAt = new Date(NOW.getTime() - 1000 * 60 * 60 * 24 * 5);
    expect(daysRemaining(trialEndsAt, NOW)).toBe(0);
  });

  it("returns 0 exactly at the trial end instant", () => {
    expect(daysRemaining(NOW, NOW)).toBe(0);
  });
});
