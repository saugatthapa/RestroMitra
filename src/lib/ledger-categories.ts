/**
 * Account Books — Phase 19. Fixed, platform-wide category/direction
 * catalogs, same "plain, dependency-free module" pattern as
 * expense-categories.ts — shared unmodified between validation, the API
 * routes, and the dashboard UI.
 */

export const LEDGER_DIRECTIONS = ["credit", "debit"] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export const LEDGER_DIRECTION_LABELS: Record<LedgerDirection, string> = {
  credit: "Money in",
  debit: "Money out",
};

export const LEDGER_CATEGORIES = [
  "sales",
  "expense",
  "purchase",
  "due_settlement",
  "capital",
  "withdrawal",
  "other",
] as const;
export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number];

export const LEDGER_CATEGORY_LABELS: Record<LedgerCategory, string> = {
  sales: "Sales",
  expense: "Expense",
  purchase: "Purchase",
  due_settlement: "Due settled",
  capital: "Capital / owner investment",
  withdrawal: "Withdrawal",
  other: "Other",
};

// Manual entries can be filed under any category — including "sales" (a
// cash sale that never went through POS), "expense", or "purchase" (a
// small cash purchase not worth a full Inventory > Purchases record) —
// EXCEPT due_settlement, which only ever exists as the realization of one
// specific outstanding entry (see settleLedgerDue in ledger.ts) and must
// go through the dedicated settle endpoint so it stays linked via
// referenceId; a freehand "due_settlement" row would have nothing to
// settle and would break that audit trail.
export const MANUAL_LEDGER_CATEGORIES = LEDGER_CATEGORIES.filter(
  (c) => c !== "due_settlement",
) as LedgerCategory[];

export const LEDGER_DUE_STATUSES = ["none", "outstanding", "settled"] as const;
export type LedgerDueStatus = (typeof LEDGER_DUE_STATUSES)[number];
