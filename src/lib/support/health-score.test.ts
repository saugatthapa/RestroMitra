import { describe, it, expect } from "vitest";
import { computeHealthScore } from "./health-score";

const NOW = new Date("2026-08-31T12:00:00Z");

function baseInput() {
  return {
    isActive: true,
    subscriptionStatus: "active",
    trialEndsAt: null,
    lastOrderAt: new Date("2026-08-30T12:00:00Z"),
    ordersLast30Days: 40,
    onboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
    now: NOW,
  };
}

describe("computeHealthScore", () => {
  it("a fully healthy tenant scores 100 with no reasons", () => {
    const result = computeHealthScore(baseInput());
    expect(result.score).toBe(100);
    expect(result.band).toBe("healthy");
    expect(result.reasons).toEqual([]);
  });

  it("a suspended restaurant loses 40 points and is flagged", () => {
    const result = computeHealthScore({ ...baseInput(), isActive: false });
    expect(result.score).toBe(60);
    expect(result.reasons).toContainEqual({ label: "Restaurant is suspended", delta: -40 });
  });

  it("past_due subtracts 20, paused subtracts 25, cancelled/expired subtract 35", () => {
    expect(computeHealthScore({ ...baseInput(), subscriptionStatus: "past_due" }).score).toBe(80);
    expect(computeHealthScore({ ...baseInput(), subscriptionStatus: "paused" }).score).toBe(75);
    expect(computeHealthScore({ ...baseInput(), subscriptionStatus: "cancelled" }).score).toBe(65);
    expect(computeHealthScore({ ...baseInput(), subscriptionStatus: "expired" }).score).toBe(65);
  });

  it("a trial ending within 3 days is flagged, but a trial with plenty of time left is not", () => {
    const endingSoon = computeHealthScore({
      ...baseInput(),
      subscriptionStatus: "trialing",
      trialEndsAt: new Date("2026-09-02T12:00:00Z"), // 2 days out
    });
    expect(endingSoon.reasons).toContainEqual({ label: "Trial ends in 2 days", delta: -10 });

    const plentyOfTime = computeHealthScore({
      ...baseInput(),
      subscriptionStatus: "trialing",
      trialEndsAt: new Date("2026-09-20T12:00:00Z"), // 20 days out
    });
    expect(plentyOfTime.reasons).toEqual([]);
  });

  it("an already-ended trial is flagged as 'Trial has ended', not a negative day count", () => {
    const result = computeHealthScore({
      ...baseInput(),
      subscriptionStatus: "trialing",
      trialEndsAt: new Date("2026-08-25T12:00:00Z"), // in the past
    });
    expect(result.reasons).toContainEqual({ label: "Trial has ended", delta: -10 });
  });

  it("no orders ever, past the onboarding grace period, is flagged", () => {
    const result = computeHealthScore({
      ...baseInput(),
      lastOrderAt: null,
      ordersLast30Days: 0,
    });
    expect(result.reasons).toContainEqual({ label: "No orders placed yet", delta: -25 });
  });

  it("a brand-new tenant (within the onboarding grace period) is NOT penalized for having no orders yet", () => {
    const result = computeHealthScore({
      ...baseInput(),
      lastOrderAt: null,
      ordersLast30Days: 0,
      onboardingCompletedAt: new Date("2026-08-30T00:00:00Z"), // yesterday
    });
    expect(result.reasons).toEqual([]);
    expect(result.score).toBe(100);
  });

  it("no orders in the last 30 days (but has ordered before) is flagged", () => {
    const result = computeHealthScore({
      ...baseInput(),
      lastOrderAt: new Date("2026-06-01T00:00:00Z"), // months ago
      ordersLast30Days: 0,
    });
    expect(result.reasons).toContainEqual({ label: "No orders in the last 30 days", delta: -25 });
  });

  it("low order volume (recent, but under the threshold) is flagged distinctly from 'no orders'", () => {
    const result = computeHealthScore({
      ...baseInput(),
      lastOrderAt: new Date("2026-08-30T00:00:00Z"),
      ordersLast30Days: 2,
    });
    expect(result.reasons).toContainEqual({
      label: "Low order volume (2 orders in the last 30 days)",
      delta: -10,
    });
  });

  it("score never goes below 0 even when every penalty stacks", () => {
    const result = computeHealthScore({
      isActive: false,
      subscriptionStatus: "cancelled",
      trialEndsAt: null,
      lastOrderAt: null,
      ordersLast30Days: 0,
      onboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
      now: NOW,
    });
    expect(result.score).toBe(0);
    expect(result.band).toBe("at_risk");
  });

  it("band thresholds: >=75 healthy, 45-74 watch, <45 at_risk", () => {
    expect(computeHealthScore({ ...baseInput(), subscriptionStatus: "past_due" }).band).toBe("healthy"); // 80
    expect(computeHealthScore({ ...baseInput(), isActive: false }).band).toBe("watch"); // 60
    // Suspended (-40) AND paused (-25) stack to 35, crossing into at_risk.
    expect(
      computeHealthScore({ ...baseInput(), subscriptionStatus: "paused", isActive: false }).score,
    ).toBe(35);
    expect(
      computeHealthScore({ ...baseInput(), subscriptionStatus: "paused", isActive: false }).band,
    ).toBe("at_risk");
  });
});
