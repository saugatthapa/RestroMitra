/**
 * Phase 21 — an expense's approval/payment workflow state. Dependency-free
 * (no "server-only", no DB import), same pattern as order-status.ts, so
 * it's shared unmodified between API routes and dashboard UI and directly
 * unit-testable.
 *
 * pending_approval -> approved -> paid is the full path for a creator with
 * neither approve nor pay authority. rejected is reachable only from
 * pending_approval (a terminal dead end — a rejected expense is
 * resubmitted as a new one, not un-rejected). See
 * resolveInitialExpenseStatus in expense-workflow.ts for how a creator's
 * own permissions can skip straight to "approved" or "paid".
 */

export const EXPENSE_STATUSES = ["pending_approval", "approved", "rejected", "paid"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  pending_approval: "Pending approval",
  approved: "Approved — awaiting payment",
  rejected: "Rejected",
  paid: "Paid",
};

const ALLOWED_TRANSITIONS: Record<ExpenseStatus, ExpenseStatus[]> = {
  pending_approval: ["approved", "rejected"],
  approved: ["paid"],
  rejected: [],
  paid: [],
};

export function canTransitionExpenseStatus(from: ExpenseStatus, to: ExpenseStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
