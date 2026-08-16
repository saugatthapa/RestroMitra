/**
 * Fixed, platform-wide expense category list — Phase 8c. Deliberately a
 * plain, dependency-free module (no "server-only", no DB import), same
 * pattern as staff-roles.ts/order-status.ts, so it's shared unmodified
 * between the API validation schema and the dashboard UI.
 *
 * A fixed enum rather than a per-restaurant custom-category table (like
 * suppliers) is a deliberate MVP simplification — see PHASE_8c_NOTES.md's
 * "Known gaps" for why custom categories are deferred rather than
 * half-built.
 */

export const EXPENSE_CATEGORIES = [
  "rent",
  "utilities",
  "salaries",
  "supplies",
  "maintenance",
  "marketing",
  "transport",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  rent: "Rent",
  utilities: "Utilities",
  salaries: "Salaries",
  supplies: "Supplies",
  maintenance: "Maintenance",
  marketing: "Marketing",
  transport: "Transport",
  other: "Other",
};
