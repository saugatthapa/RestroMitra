/**
 * Phase 9 — pure, dependency-free report math (no "server-only", no DB
 * import), same pattern as order-status.ts/loyalty-tiers.ts, so it's
 * directly unit-testable and shared unmodified between the reports API
 * route and the dashboard UI (e.g. for client-side re-derivation like net
 * profit once the summary payload is in hand).
 */

/** Inclusive YYYY-MM-DD date range, e.g. every day from "2026-08-01" to "2026-08-07". */
export function generateDateRange(fromIso: string, toIso: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${fromIso}T00:00:00.000Z`);
  const end = new Date(`${toIso}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime()) || cursor > end) {
    return dates;
  }
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export type DailySeriesPoint = {
  date: string;
  revenueInPaisa: number;
  expensesInPaisa: number;
};

/**
 * Fills in every day in the range with 0 for revenue/expenses when the DB
 * query returned no row for that day (a day with no completed orders and
 * no expenses is a real, meaningful zero — not a gap the chart should
 * skip over).
 */
export function mergeDailySeries(
  dateRange: string[],
  revenueByDate: Record<string, number>,
  expensesByDate: Record<string, number>,
): DailySeriesPoint[] {
  return dateRange.map((date) => ({
    date,
    revenueInPaisa: revenueByDate[date] ?? 0,
    expensesInPaisa: expensesByDate[date] ?? 0,
  }));
}

export function computeNetProfitInPaisa(revenueInPaisa: number, expensesInPaisa: number): number {
  return revenueInPaisa - expensesInPaisa;
}

/**
 * Rupees-per-100-days-style "average order value" — floors to the nearest
 * paisa rather than carrying a fraction, same integer-money discipline as
 * the rest of this codebase (see money.ts).
 */
export function computeAverageOrderValueInPaisa(
  revenueInPaisa: number,
  orderCount: number,
): number {
  if (orderCount <= 0) return 0;
  return Math.round(revenueInPaisa / orderCount);
}

/**
 * Phase 16b — the immediately-preceding period of the SAME LENGTH as
 * `range`, used for "vs last period" comparisons on the Reports KPI tiles.
 * Deliberately period-length-relative rather than hardcoded to "last
 * calendar month" (what the reference dashboard screenshot the user sent
 * does) — the Reports page supports arbitrary custom ranges (Today, Last 7
 * days, Last 30 days, This month, or a hand-picked from/to), and "last
 * month" only means something for a monthly window. A 7-day range compares
 * against the 7 days before it; a 30-day range against the 30 days before
 * that; a custom 3-day range against the 3 days before it. Always
 * well-defined, whatever preset or custom range is active.
 */
export function previousPeriodRange(range: { from: string; to: string }): {
  from: string;
  to: string;
} {
  const from = new Date(`${range.from}T00:00:00.000Z`);
  const to = new Date(`${range.to}T00:00:00.000Z`);
  const lengthDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

  const prevTo = new Date(from);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - (lengthDays - 1));

  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

/**
 * Percentage change from `previous` to `current`, rounded to 2 decimals.
 * Returns `null` (not 0, not Infinity) when `previous` is 0 and `current`
 * is nonzero — there's no meaningful "% change" from a zero baseline (a
 * restaurant's first-ever sale isn't "infinity percent up"); the UI shows
 * "New" for that case instead of a misleading number. Returns exactly 0
 * when both are 0 (no change, not "no data").
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}
