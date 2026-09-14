/**
 * Central catalog of account_mappings keys — same "single source of truth,
 * never a hand-rolled string" convention as PERMISSIONS
 * (src/lib/rbac/permissions.ts). Nothing reads these yet (that's Phase 4,
 * the automatic integrations), but the keys are fixed now, at the same time
 * the seed data that populates them is written, so Phase 4 code and this
 * seed data can never drift out of sync on the string itself.
 *
 * `payment_method:<method>` mirrors PAYMENT_METHODS (src/lib/payments.ts)
 * exactly — one clearing/cash account per method, per the posting matrix's
 * §1 (Sale) and §9 (Reconciliation).
 */
export const MAPPING_KEYS = {
  PAYMENT_METHOD_CASH: "payment_method:cash",
  PAYMENT_METHOD_CARD: "payment_method:card",
  PAYMENT_METHOD_MOBILE_WALLET: "payment_method:mobile_wallet",
  PAYMENT_METHOD_OTHER: "payment_method:other",
  ACCOUNTS_RECEIVABLE: "control:accounts_receivable",
  ACCOUNTS_PAYABLE: "control:accounts_payable",
  TAX_PAYABLE: "control:tax_payable",
  TIPS_PAYABLE: "control:tips_payable",
  SALES_REVENUE: "control:sales_revenue",
  SERVICE_CHARGE_REVENUE: "control:service_charge_revenue",
  DISCOUNTS_AND_ALLOWANCES: "control:discounts_and_allowances",
  SALES_RETURNS_AND_REFUNDS: "control:sales_returns_and_refunds",
  INVENTORY: "control:inventory",
  COST_OF_GOODS_SOLD: "control:cost_of_goods_sold",
  SALARY_EXPENSE: "control:salary_expense",
  SALARY_PAYABLE: "control:salary_payable",
  OPENING_BALANCE_EQUITY: "control:opening_balance_equity",
  // Phase 4, Slice 4d — expense payments only, never a POS sales payment
  // method. EXPENSE_PAYMENT_METHODS (finance/expense-payment-methods.ts)
  // has six values (cash, bank_transfer, esewa, khalti, mobile_banking,
  // other) that don't line up 1:1 with the four PAYMENT_METHOD_* keys
  // above (those are POS-sales-shaped: cash/card/mobile_wallet/other, and
  // "card" doesn't even apply to money going OUT). Per sign-off: cash and
  // "other" reuse PAYMENT_METHOD_CASH/PAYMENT_METHOD_OTHER (same physical
  // till/bucket either flow uses); bank_transfer, esewa, khalti, and
  // mobile_banking all share this one account instead of getting four of
  // their own, since nothing today reconciles or distinguishes between
  // them — easy to split apart once Phase 5 adds real Bank Accounts.
  BANK_DIGITAL_PAYMENTS: "control:bank_digital_payments",
  // Phase 4, Slice 4f — a minimal single Bank Account, pulled forward from
  // Phase 5 specifically to unblock this slice (per sign-off: rather than
  // blocking all of Phase 4 on Phase 5, or skipping reconciliation posting
  // indefinitely — see ACCOUNTING_PHASE_4_PLAN.md Part 5 #8). Represents
  // "money actually confirmed in the bank" once a card/mobile_wallet/other
  // payment is reconciled against a real bank/gateway statement — distinct
  // from BANK_DIGITAL_PAYMENTS above, which is an outgoing clearing bucket
  // for expense/payroll payouts, not an incoming settlement account. Phase 5
  // proper replaces this one default account with real multi-bank-account
  // support; nothing here needs to change for that migration except adding
  // more mapping keys alongside this one.
  BANK_ACCOUNT: "control:bank_account",
  // Phase 6, Slice 6a — the recoverable VAT a VAT-registered supplier
  // charged on a purchase, additive to that purchase's own goods/service
  // cost (never carved out of it — see chart-of-accounts.ts's own "1150
  // Input VAT Receivable" comment and integrations/purchases.ts's
  // postPurchaseVoucher). A future VAT-return report (Slice 6c) nets this
  // asset against TAX_PAYABLE's own Output VAT credits.
  INPUT_VAT: "control:input_vat",
} as const;

export type MappingKey = (typeof MAPPING_KEYS)[keyof typeof MAPPING_KEYS];
