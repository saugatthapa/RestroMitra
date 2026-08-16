import { describe, it, expect } from "vitest";
import {
  computeDiscountInPaisa,
  computeServiceChargeInPaisa,
  computeOrderTotals,
} from "./order-adjustments";

describe("computeDiscountInPaisa", () => {
  it("returns 0 when discountType is null/undefined", () => {
    expect(computeDiscountInPaisa(null, 1000, 10_000)).toBe(0);
    expect(computeDiscountInPaisa(undefined, 1000, 10_000)).toBe(0);
  });

  it("returns 0 when discountValue is null/undefined/0", () => {
    expect(computeDiscountInPaisa("percentage", null, 10_000)).toBe(0);
    expect(computeDiscountInPaisa("percentage", undefined, 10_000)).toBe(0);
    expect(computeDiscountInPaisa("percentage", 0, 10_000)).toBe(0);
  });

  it("computes a percentage discount from basis points", () => {
    // 10% of 10,000 paisa = 1,000 paisa
    expect(computeDiscountInPaisa("percentage", 1_000, 10_000)).toBe(1_000);
  });

  it("rounds a percentage discount to the nearest paisa", () => {
    // 33.33% (3333 bps) of 10,000 = 3333.0 -> round(3333) = 3333
    expect(computeDiscountInPaisa("percentage", 3_333, 10_000)).toBe(3_333);
    // 1/3 of 100: 3333 bps of 100 = 33.33 -> rounds to 33
    expect(computeDiscountInPaisa("percentage", 3_333, 100)).toBe(33);
  });

  it("clamps a 100% percentage discount to exactly the subtotal", () => {
    expect(computeDiscountInPaisa("percentage", 10_000, 12_345)).toBe(12_345);
  });

  it("clamps a percentage discount above 100% to the subtotal", () => {
    // Not something valid input should produce (schema caps at 100%), but
    // the clamp is a defense-in-depth invariant, not just a validation rule.
    expect(computeDiscountInPaisa("percentage", 15_000, 10_000)).toBe(10_000);
  });

  it("computes a flat discount as-is when within the subtotal", () => {
    expect(computeDiscountInPaisa("flat", 2_500, 10_000)).toBe(2_500);
  });

  it("clamps a flat discount larger than the subtotal down to the subtotal", () => {
    expect(computeDiscountInPaisa("flat", 50_000, 10_000)).toBe(10_000);
  });

  it("never returns a negative discount", () => {
    expect(computeDiscountInPaisa("flat", -500, 10_000)).toBe(0);
    expect(computeDiscountInPaisa("percentage", -100, 10_000)).toBe(0);
  });

  it("handles a zero subtotal without going negative or dividing by zero", () => {
    expect(computeDiscountInPaisa("percentage", 5_000, 0)).toBe(0);
    expect(computeDiscountInPaisa("flat", 5_000, 0)).toBe(0);
  });
});

describe("computeServiceChargeInPaisa", () => {
  it("returns 0 when basis points is null/undefined/0", () => {
    expect(computeServiceChargeInPaisa(null, 10_000)).toBe(0);
    expect(computeServiceChargeInPaisa(undefined, 10_000)).toBe(0);
    expect(computeServiceChargeInPaisa(0, 10_000)).toBe(0);
  });

  it("computes a standard 10% service charge", () => {
    expect(computeServiceChargeInPaisa(1_000, 10_000)).toBe(1_000);
  });

  it("rounds to the nearest paisa", () => {
    expect(computeServiceChargeInPaisa(3_333, 100)).toBe(33);
  });

  it("never returns a negative value", () => {
    expect(computeServiceChargeInPaisa(-500, 10_000)).toBe(0);
  });

  it("handles a zero subtotal", () => {
    expect(computeServiceChargeInPaisa(1_000, 0)).toBe(0);
  });
});

describe("computeOrderTotals", () => {
  it("with no discount/service charge, total is subtotal + tax (unchanged from pre-Phase-13 behavior)", () => {
    const result = computeOrderTotals({ subtotalInPaisa: 10_000, taxInPaisa: 1_300 });
    expect(result).toEqual({
      discountInPaisa: 0,
      serviceChargeInPaisa: 0,
      totalInPaisa: 11_300,
    });
  });

  it("applies a percentage discount against the subtotal only, leaving tax untouched", () => {
    // subtotal 10,000; 10% discount -> 1,000 off; tax 1,300 unchanged
    const result = computeOrderTotals({
      subtotalInPaisa: 10_000,
      taxInPaisa: 1_300,
      discountType: "percentage",
      discountValue: 1_000, // 10% in basis points
    });
    expect(result).toEqual({
      discountInPaisa: 1_000,
      serviceChargeInPaisa: 0,
      totalInPaisa: 10_300, // 10,000 - 1,000 + 0 + 1,300
    });
  });

  it("applies a flat discount", () => {
    const result = computeOrderTotals({
      subtotalInPaisa: 10_000,
      taxInPaisa: 1_300,
      discountType: "flat",
      discountValue: 2_000,
    });
    expect(result).toEqual({
      discountInPaisa: 2_000,
      serviceChargeInPaisa: 0,
      totalInPaisa: 9_300, // 10,000 - 2,000 + 0 + 1,300
    });
  });

  it("applies a service charge on top of the subtotal, additive with tax", () => {
    const result = computeOrderTotals({
      subtotalInPaisa: 10_000,
      taxInPaisa: 1_300,
      serviceChargeBasisPoints: 1_000, // 10%
    });
    expect(result).toEqual({
      discountInPaisa: 0,
      serviceChargeInPaisa: 1_000,
      totalInPaisa: 12_300, // 10,000 - 0 + 1,000 + 1,300
    });
  });

  it("applies discount and service charge together, both against the subtotal independently", () => {
    const result = computeOrderTotals({
      subtotalInPaisa: 10_000,
      taxInPaisa: 1_300,
      discountType: "percentage",
      discountValue: 1_000, // 10% off -> 1,000
      serviceChargeBasisPoints: 1_000, // 10% on top -> 1,000
    });
    expect(result).toEqual({
      discountInPaisa: 1_000,
      serviceChargeInPaisa: 1_000,
      totalInPaisa: 11_300, // 10,000 - 1,000 + 1,000 + 1,300
    });
  });

  it("a 100% discount zeroes the subtotal contribution but tax and service charge still apply", () => {
    const result = computeOrderTotals({
      subtotalInPaisa: 10_000,
      taxInPaisa: 1_300,
      discountType: "percentage",
      discountValue: 10_000, // 100%
      serviceChargeBasisPoints: 1_000,
    });
    expect(result).toEqual({
      discountInPaisa: 10_000,
      serviceChargeInPaisa: 1_000,
      totalInPaisa: 2_300, // 10,000 - 10,000 + 1,000 + 1,300
    });
  });

  it("a flat discount exceeding the subtotal clamps rather than producing a negative total contribution", () => {
    const result = computeOrderTotals({
      subtotalInPaisa: 5_000,
      taxInPaisa: 650,
      discountType: "flat",
      discountValue: 50_000,
    });
    expect(result).toEqual({
      discountInPaisa: 5_000, // clamped to subtotal
      serviceChargeInPaisa: 0,
      totalInPaisa: 650, // 5,000 - 5,000 + 0 + 650
    });
  });

  it("handles an order with zero subtotal and zero tax (e.g. fully-comped items) gracefully", () => {
    const result = computeOrderTotals({ subtotalInPaisa: 0, taxInPaisa: 0 });
    expect(result).toEqual({ discountInPaisa: 0, serviceChargeInPaisa: 0, totalInPaisa: 0 });
  });
});
