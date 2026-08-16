import { describe, it, expect } from "vitest";
import { resolveLoyaltyRedemption, POINTS_REDEMPTION_VALUE_PAISA } from "./loyalty-redemption";

describe("resolveLoyaltyRedemption", () => {
  it("redeems the full requested amount when balance and subtotal both cover it", () => {
    const result = resolveLoyaltyRedemption({
      requestedPoints: 50,
      customerPointsBalance: 200,
      subtotalInPaisa: 100_00,
    });
    expect(result.pointsToRedeem).toBe(50);
    expect(result.redemptionValueInPaisa).toBe(50 * POINTS_REDEMPTION_VALUE_PAISA);
  });

  it("clamps to the customer's balance when they request more than they have", () => {
    const result = resolveLoyaltyRedemption({
      requestedPoints: 500,
      customerPointsBalance: 120,
      // A big subtotal so the balance — not the subtotal cap — is the
      // binding constraint here.
      subtotalInPaisa: 1_000_00,
    });
    expect(result.pointsToRedeem).toBe(120);
    expect(result.redemptionValueInPaisa).toBe(120 * POINTS_REDEMPTION_VALUE_PAISA);
  });

  it("clamps to what the subtotal can absorb, rounding DOWN to a whole point", () => {
    // Subtotal Rs 45.00 = 4500 paisa -> at Rs 1/point, max affordable is 45 points exactly.
    const result = resolveLoyaltyRedemption({
      requestedPoints: 100,
      customerPointsBalance: 200,
      subtotalInPaisa: 45_00,
    });
    expect(result.pointsToRedeem).toBe(45);
    expect(result.redemptionValueInPaisa).toBe(45_00);
  });

  it("rounds the subtotal cap down when it doesn't divide evenly by the redemption rate", () => {
    // Subtotal Rs 45.50 = 4550 paisa -> 45.5 points worth, floors to 45 (never a fractional point).
    const result = resolveLoyaltyRedemption({
      requestedPoints: 100,
      customerPointsBalance: 200,
      subtotalInPaisa: 45_50,
    });
    expect(result.pointsToRedeem).toBe(45);
    expect(result.redemptionValueInPaisa).toBe(45_00);
  });

  it("returns zero when the customer has no points", () => {
    const result = resolveLoyaltyRedemption({
      requestedPoints: 20,
      customerPointsBalance: 0,
      subtotalInPaisa: 100_00,
    });
    expect(result.pointsToRedeem).toBe(0);
    expect(result.redemptionValueInPaisa).toBe(0);
  });

  it("returns zero when the subtotal is too small to absorb even 1 point", () => {
    // Subtotal 50 paisa (Rs 0.50) < the Rs 1 redemption rate for a single point.
    const result = resolveLoyaltyRedemption({
      requestedPoints: 5,
      customerPointsBalance: 100,
      subtotalInPaisa: 50,
    });
    expect(result.pointsToRedeem).toBe(0);
    expect(result.redemptionValueInPaisa).toBe(0);
  });

  it("never redeems a negative amount even with malformed negative inputs", () => {
    const result = resolveLoyaltyRedemption({
      requestedPoints: -10,
      customerPointsBalance: 100,
      subtotalInPaisa: 100_00,
    });
    expect(result.pointsToRedeem).toBe(0);
    expect(result.redemptionValueInPaisa).toBe(0);
  });

  it("floors a fractional requestedPoints input rather than over-redeeming", () => {
    const result = resolveLoyaltyRedemption({
      requestedPoints: 10.9,
      customerPointsBalance: 100,
      subtotalInPaisa: 100_00,
    });
    expect(result.pointsToRedeem).toBe(10);
  });
});
