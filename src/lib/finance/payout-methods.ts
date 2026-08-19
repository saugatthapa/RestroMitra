/**
 * Phase 22 — the shared "how did money physically leave the business"
 * catalog for every OUTGOING payment RestroMitra tracks: expense payouts
 * (expense-payment-methods.ts re-exports these under its old names, so
 * nothing there needed to change) and now payroll (payroll's own
 * validation/UI import this module directly).
 *
 * IMPORTANT — see PaymentConfirmationKind below: none of these methods get
 * automatic server-side verification the way an incoming customer eSewa/
 * Khalti payment does (src/lib/payment-gateways/). RestroMitra's eSewa/
 * Khalti integration is a COLLECTION integration only — there is no payout/
 * disbursement API wired up, and getting one requires a separate merchant
 * agreement RestroMitra doesn't have. So even "esewa"/"khalti" here just
 * mean "I sent it via my eSewa/Khalti app" — confirmed by the authorized
 * human who paid it, exactly like cash or a bank transfer.
 */

export const PAYOUT_METHODS = [
  "cash",
  "bank_transfer",
  "esewa",
  "khalti",
  "mobile_banking",
  "other",
] as const;

export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
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

export function confirmationKindFor(_method: PayoutMethod): PaymentConfirmationKind {
  return "manual";
}
