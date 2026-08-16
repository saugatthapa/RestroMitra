import { describe, it, expect } from "vitest";
import { tierForPoints, pointsToNextTier, LOYALTY_TIERS } from "./loyalty-tiers";

describe("tierForPoints", () => {
  it("starts everyone at Bronze with zero lifetime points", () => {
    expect(tierForPoints(0)).toBe("Bronze");
  });

  it("returns the highest tier reached, at each threshold boundary", () => {
    expect(tierForPoints(499)).toBe("Bronze");
    expect(tierForPoints(500)).toBe("Silver");
    expect(tierForPoints(1499)).toBe("Silver");
    expect(tierForPoints(1500)).toBe("Gold");
    expect(tierForPoints(2999)).toBe("Gold");
    expect(tierForPoints(3000)).toBe("Platinum");
    expect(tierForPoints(50_000)).toBe("Platinum");
  });

  it("never demotes based on current spendable balance — only lifetime points matter", () => {
    // A customer who earned 3000 lifetime points and redeemed all of it
    // down to a balance of 0 is still Platinum — this function only ever
    // takes lifetime points as input, so there's no way to accidentally
    // wire a spendable balance into it and get a demotion.
    expect(tierForPoints(3000)).toBe("Platinum");
  });
});

describe("pointsToNextTier", () => {
  it("computes the gap to the next threshold", () => {
    expect(pointsToNextTier(0)).toBe(500);
    expect(pointsToNextTier(400)).toBe(100);
    expect(pointsToNextTier(500)).toBe(1000);
  });

  it("returns null once the top tier is reached", () => {
    expect(pointsToNextTier(3000)).toBeNull();
    expect(pointsToNextTier(1_000_000)).toBeNull();
  });
});

describe("LOYALTY_TIERS", () => {
  it("is sorted ascending by minPoints with Bronze at zero", () => {
    expect(LOYALTY_TIERS[0]).toEqual({ name: "Bronze", minPoints: 0 });
    for (let i = 1; i < LOYALTY_TIERS.length; i++) {
      expect(LOYALTY_TIERS[i].minPoints).toBeGreaterThan(LOYALTY_TIERS[i - 1].minPoints);
    }
  });
});
