import { describe, it, expect } from "vitest";
import {
  paisaToRupees,
  rupeesToPaisa,
  formatNPR,
  applyTax,
  percentToBasisPoints,
  basisPointsToPercent,
} from "./money";

describe("money helpers (integer paisa, no floats)", () => {
  it("converts rupees to paisa without float drift", () => {
    expect(rupeesToPaisa(180)).toBe(18000);
    expect(rupeesToPaisa(19.99)).toBe(1999);
    expect(rupeesToPaisa(0.1)).toBe(10);
  });

  it("converts paisa back to rupees", () => {
    expect(paisaToRupees(18000)).toBe(180);
    expect(paisaToRupees(1999)).toBeCloseTo(19.99, 5);
  });

  it("formats NPR with two decimal places", () => {
    expect(formatNPR(18000)).toBe("Rs. 180.00");
    expect(formatNPR(150)).toBe("Rs. 1.50");
    expect(formatNPR(0)).toBe("Rs. 0.00");
  });

  it("applies tax in basis points without float error", () => {
    // Rs. 180.00 at 13.00% VAT = Rs. 23.40 = 2340 paisa
    expect(applyTax(18000, 1300)).toBe(2340);
  });

  it("basis point <-> percent round-trips", () => {
    expect(percentToBasisPoints(13)).toBe(1300);
    expect(basisPointsToPercent(1300)).toBe(13);
  });

  it("the classic float trap does not affect paisa math", () => {
    // 0.1 + 0.2 !== 0.3 in float. In paisa, 10 + 20 === 30, exactly.
    const a = rupeesToPaisa(0.1);
    const b = rupeesToPaisa(0.2);
    expect(a + b).toBe(30);
  });
});
