import { describe, it, expect } from "vitest";
import { computePayslipTotals } from "./payslip";

describe("computePayslipTotals", () => {
  it("with no deductions, gross equals net", () => {
    const totals = computePayslipTotals(50_000_00, null);
    expect(totals.netAmountInPaisa).toBe(50_000_00);
    expect(totals.grossAmountInPaisa).toBe(50_000_00);
    expect(totals.totalDeductionsInPaisa).toBe(0);
    expect(totals.deductions).toEqual([]);
  });

  it("undefined deductions behaves the same as null (old rows before this column existed)", () => {
    const totals = computePayslipTotals(50_000_00, undefined);
    expect(totals.grossAmountInPaisa).toBe(50_000_00);
  });

  it("adds itemized deductions on top of the net amount to derive gross", () => {
    const totals = computePayslipTotals(45_000_00, [
      { label: "Advance recovery", amountInPaisa: 4_000_00 },
      { label: "Uniform", amountInPaisa: 1_000_00 },
    ]);
    expect(totals.totalDeductionsInPaisa).toBe(5_000_00);
    expect(totals.grossAmountInPaisa).toBe(50_000_00);
    expect(totals.deductions).toHaveLength(2);
  });

  it("drops non-positive or non-finite deduction amounts rather than corrupting the total", () => {
    const totals = computePayslipTotals(50_000_00, [
      { label: "Bad", amountInPaisa: 0 },
      { label: "Negative", amountInPaisa: -100 },
      { label: "NaN", amountInPaisa: Number.NaN },
      { label: "Good", amountInPaisa: 500_00 },
    ]);
    expect(totals.deductions).toEqual([{ label: "Good", amountInPaisa: 500_00 }]);
    expect(totals.totalDeductionsInPaisa).toBe(500_00);
    expect(totals.grossAmountInPaisa).toBe(50_500_00);
  });

  it("never mutates net even when deductions total to zero after filtering", () => {
    const totals = computePayslipTotals(50_000_00, [{ label: "Bad", amountInPaisa: -5 }]);
    expect(totals.netAmountInPaisa).toBe(50_000_00);
    expect(totals.grossAmountInPaisa).toBe(50_000_00);
  });
});
