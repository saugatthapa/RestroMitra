/**
 * Plain, dependency-free expense business logic — no "server-only", no DB
 * import — same pattern as order-status.ts/expense-categories.ts, so it's
 * trivially unit-testable without a database or session.
 */

/**
 * Determines which business-day(s) a PATCH to an expense needs to check
 * against the daily-close lock (assertBusinessDayWritable, in
 * daily-closing.ts) before the update is allowed to proceed.
 *
 * QA hardening pass (Phase 43 / adversarial self-audit — daily-close lock
 * coverage gap). Every other financial-mutation route in this hardening
 * pass got a daily-close check, but expenses/[expenseId]/route.ts's PATCH
 * — which can both void a paid expense (reversing its ledger entry) and
 * retitle a paid expense's own expenseDate — was missed, since it edits an
 * existing row rather than creating/paying a new one. Two distinct risks:
 *  - voiding a paid expense reverses its ledger entry on the day it was
 *    originally booked (existing.expenseDate) — if that day is already
 *    closed, this must raise the same trust bar as any other reversal.
 *  - retitling expenseDate on an already-paid expense moves its value
 *    between two different days' totals (getTotalExpensesInPaisa in
 *    reports.ts buckets purely by expenseDate) — both the OLD and the NEW
 *    day are returned, since either could be an already-closed day being
 *    silently disturbed.
 *
 * Extracted as a pure function (rather than left inline in the route) so
 * this decision logic is unit-testable on its own — this codebase's
 * established convention is that API route handlers can't be exercised
 * directly in tests (no session-mocking harness; see
 * expense-void-cas.test.ts's own doc comment), so anything with real
 * branching logic worth covering gets pulled out into a plain function
 * like this one.
 *
 * Returns a deduplicated array (order not significant) — empty when
 * neither risk applies (a pending expense being edited, or a paid expense
 * having only its amount/category/note changed, which are separately
 * blocked from ever reaching here once paid — see the route's own
 * `changingAmountOrCategory` check).
 */
export function resolveExpenseDailyCloseCheckDates(
  existing: { status: string; expenseDate: string; isVoided: boolean },
  data: { expenseDate?: string; isVoided?: boolean },
): string[] {
  const togglingVoid = data.isVoided !== undefined && data.isVoided !== existing.isVoided;
  const dates = new Set<string>();

  if (togglingVoid) {
    dates.add(existing.expenseDate);
  }
  if (
    existing.status === "paid" &&
    data.expenseDate !== undefined &&
    data.expenseDate !== existing.expenseDate
  ) {
    dates.add(existing.expenseDate);
    dates.add(data.expenseDate);
  }

  return [...dates];
}
