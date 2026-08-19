/**
 * Phase 21 — how an expense was actually settled once PAID.
 *
 * Phase 22: the underlying definitions moved to payout-methods.ts once
 * payroll needed the exact same "cash/bank_transfer/esewa/khalti/
 * mobile_banking/other, every one manual-confirmation-only" catalog for
 * staff salary payouts — re-exported here under their original names so
 * every existing import (validation/expenses.ts, the expenses API routes,
 * ExpensesBoard.tsx) keeps working unchanged. New code should prefer
 * importing from payout-methods.ts directly; this file is kept as a thin
 * compatibility layer for the expense-specific names already in use.
 */
import {
  PAYOUT_METHODS,
  PAYOUT_METHOD_LABELS,
  confirmationKindFor as payoutConfirmationKindFor,
  type PayoutMethod,
  type PaymentConfirmationKind,
} from "./payout-methods";

export const EXPENSE_PAYMENT_METHODS = PAYOUT_METHODS;
export type ExpensePaymentMethod = PayoutMethod;
export const EXPENSE_PAYMENT_METHOD_LABELS = PAYOUT_METHOD_LABELS;
export type { PaymentConfirmationKind };

export function confirmationKindFor(method: ExpensePaymentMethod): PaymentConfirmationKind {
  return payoutConfirmationKindFor(method);
}
