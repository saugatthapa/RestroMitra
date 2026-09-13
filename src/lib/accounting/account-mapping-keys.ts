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
} as const;

export type MappingKey = (typeof MAPPING_KEYS)[keyof typeof MAPPING_KEYS];
