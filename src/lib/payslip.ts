/**
 * Commercial completion pass — payslip generation. This project was
 * explicitly told NOT to invent Nepal statutory tax rules (PF/SSF/TDS) —
 * see the new master prompt's instruction to "support configurable fields
 * rather than inventing legal rules." So a payslip here is a receipt of
 * what was actually paid and what was itemized as withheld
 * (payrollPayments.deductionsJson — free-text label + manually-entered
 * amount, e.g. "Advance recovery"), never a computed tax/PF/SSF figure.
 *
 * Deliberately dependency-free (no "server-only", no DB import) — pure
 * arithmetic over already-fetched data, so it's trivially unit-testable
 * and reusable from both the API route (JSON) and, if ever needed, a
 * server-rendered PDF/print path without re-deriving this logic twice.
 */

export type PayslipDeduction = { label: string; amountInPaisa: number };

export type PayslipTotals = {
  /** The actual amount paid — payrollPayments.amountInPaisa, unchanged meaning. */
  netAmountInPaisa: number;
  deductions: PayslipDeduction[];
  totalDeductionsInPaisa: number;
  /** Derived, never stored: net + sum(deductions). */
  grossAmountInPaisa: number;
};

export function computePayslipTotals(
  netAmountInPaisa: number,
  deductions: PayslipDeduction[] | null | undefined,
): PayslipTotals {
  const list = (deductions ?? []).filter(
    (d) => Number.isFinite(d.amountInPaisa) && d.amountInPaisa > 0,
  );
  const totalDeductionsInPaisa = list.reduce((sum, d) => sum + d.amountInPaisa, 0);
  return {
    netAmountInPaisa,
    deductions: list,
    totalDeductionsInPaisa,
    grossAmountInPaisa: netAmountInPaisa + totalDeductionsInPaisa,
  };
}
