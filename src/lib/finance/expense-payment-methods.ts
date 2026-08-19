/**
 * Phase 21 — how an expense was actually settled once PAID. Deliberately
 * dependency-free (no "server-only", no DB import), same pattern as
 * payments.ts's PAYMENT_METHODS, so it's shared unmodified between Zod
 * validation, API routes, and dashboard UI.
 *
 * Distinct from PAYMENT_METHODS (payments.ts — cash/card/mobile_wallet/
 * other, for a CUSTOMER paying an order): an outgoing business payment
 * has no "card" concept, and splits "mobile wallet" into esewa/khalti
 * explicitly so payment-method breakdown reporting can tell them apart.
 *
 * IMPORTANT — see PaymentConfirmationKind below: none of these methods
 * get automatic server-side verification the way an incoming customer
 * eSewa/Khalti payment does (src/lib/payment-gateways/). RestroMitra's
 * eSewa/Khalti integration is a COLLECTION integration only — there is no
 * payout/disbursement API wired up, and getting one requires a separate
 * merchant agreement RestroMitra doesn't have. So even "esewa"/"khalti"
 * here just mean "I sent it via my eSewa/Khalti app" — confirmed by the
 * authorized human who paid it, exactly like cash or a bank transfer.
 */

export const EXPENSE_PAYMENT_METHODS = [
  "cash",
  "bank_transfer",
  "esewa",
  "khalti",
  "mobile_banking",
  "other",
] as const;

export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

export const EXPENSE_PAYMENT_METHOD_LABELS: Record<ExpensePaymentMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  esewa: "eSewa",
  khalti: "Khalti",
  mobile_banking: "Mobile banking",
  other: "Other",
};

/**
 * Every outgoing-payment method today resolves to "manual" — see the
 * module doc comment above. This type exists so the architecture has
 * somewhere to plug in a real "provider_verified" kind later IF
 * RestroMitra ever gets payout/disbursement API access from a provider,
 * without every call site needing to change — but nothing in this
 * codebase should claim "provider_verified" today.
 */
export type PaymentConfirmationKind = "manual" | "provider_verified";

export function confirmationKindFor(_method: ExpensePaymentMethod): PaymentConfirmationKind {
  return "manual";
}
