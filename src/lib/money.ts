/**
 * All money in DhankiPOS is stored and computed as integer paisa
 * (1/100 NPR) — never as a float. Floats cannot represent most decimal
 * fractions exactly (0.1 + 0.2 !== 0.3 in IEEE-754), which is exactly the
 * kind of error that must never happen in a bill total. Integers under
 * addition/subtraction/multiplication-by-integer have no such problem.
 *
 * These helpers are the only place formatting/parsing happens — route
 * handlers and UI code should go through them rather than doing ad hoc
 * `/100` math, so rounding behavior stays consistent everywhere.
 */

export function paisaToRupees(paisa: number): number {
  return paisa / 100;
}

export function rupeesToPaisa(rupees: number): number {
  // Round to the nearest paisa rather than truncating, and do the
  // multiplication in a way that avoids the classic 19.99 * 100 = 1998.999…
  // float artifact.
  return Math.round(rupees * 100);
}

export function formatNPR(paisa: number): string {
  const rupees = paisaToRupees(paisa);
  return `Rs. ${rupees.toLocaleString("en-NP", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Basis points: 1/100 of a percent. 1300 == 13.00%. */
export function basisPointsToPercent(bp: number): number {
  return bp / 100;
}

export function percentToBasisPoints(percent: number): number {
  return Math.round(percent * 100);
}

/** Applies a tax rate (in basis points) to an amount (in paisa), rounding to the nearest paisa. */
export function applyTax(amountInPaisa: number, taxRateBasisPoints: number): number {
  return Math.round((amountInPaisa * taxRateBasisPoints) / 10_000);
}
