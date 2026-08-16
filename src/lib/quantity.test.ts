import { describe, it, expect } from "vitest";
import { milliunitsToUnits, unitsToMilliunits, formatQuantity } from "./quantity";

describe("unitsToMilliunits / milliunitsToUnits", () => {
  it("round-trips exact values", () => {
    expect(unitsToMilliunits(2.5)).toBe(2500);
    expect(milliunitsToUnits(2500)).toBe(2.5);
    expect(unitsToMilliunits(0.001)).toBe(1);
    expect(unitsToMilliunits(12)).toBe(12000);
  });

  it("rounds to the nearest milliunit instead of truncating a float artifact", () => {
    // The classic 2.5 * 1000 float artifact (2499.999999999997 in raw JS)
    // must round to exactly 2500, not 2499.
    expect(unitsToMilliunits(2.5)).toBe(2500);
    expect(unitsToMilliunits(0.1 + 0.2)).toBe(300); // 0.1+0.2 = 0.30000000000000004
  });

  it("handles zero", () => {
    expect(unitsToMilliunits(0)).toBe(0);
    expect(milliunitsToUnits(0)).toBe(0);
  });
});

describe("formatQuantity", () => {
  it("trims trailing zeros", () => {
    expect(formatQuantity(2500, "kg")).toBe("2.5 kg");
    expect(formatQuantity(12000, "piece")).toBe("12 pc");
    expect(formatQuantity(1000, "l")).toBe("1 L");
  });

  it("keeps up to 3 decimal places for sub-gram/ml precision", () => {
    expect(formatQuantity(1250, "g")).toBe("1.25 g");
    expect(formatQuantity(1, "ml")).toBe("0.001 ml");
  });

  it("formats negative quantities (allowed for stock that's gone negative)", () => {
    expect(formatQuantity(-500, "kg")).toBe("-0.5 kg");
  });
});
