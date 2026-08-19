/**
 * Phase 21 — pure decision logic for what status a freshly-submitted
 * expense should land in, based on the creator's OWN permissions. Kept
 * dependency-free and separate from the API route so it's directly
 * unit-testable without a DB.
 *
 * The cascading rule is what keeps today's one-step owner/manager flow
 * working unchanged while adding the new multi-step flow for lower-trust
 * roles, rather than forcing every restaurant through an approval step
 * it didn't have yesterday:
 *
 *  - Creator holds PAY_EXPENSE (owner, accountant)        -> "paid" immediately.
 *  - Else creator holds APPROVE_EXPENSE (manager, owner)  -> "approved" immediately
 *    (they're already a trusted approver of THEIR OWN spend — still needs
 *    someone with PAY_EXPENSE to actually mark it paid).
 *  - Else (only CREATE_EXPENSE_REQUEST)                   -> "pending_approval".
 */
import type { ExpenseStatus } from "./expense-status";

export function resolveInitialExpenseStatus(authority: {
  canPay: boolean;
  canApprove: boolean;
}): ExpenseStatus {
  if (authority.canPay) return "paid";
  if (authority.canApprove) return "approved";
  return "pending_approval";
}
