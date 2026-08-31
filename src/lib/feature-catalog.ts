/**
 * Platform Control Center (Phase 4/5) — the canonical list of RestroMitra
 * capabilities a plan can include and, from Phase 5 onward, the
 * entitlement engine can gate. Same "flat string-key catalog" shape as
 * src/lib/rbac/permissions.ts's PERMISSIONS — deliberately code-defined,
 * not admin-editable: a feature key corresponds to an actual code path
 * (a route, a nav item, a UI section), so adding one is a code change by
 * definition, the same way adding a new PERMISSIONS key is.
 *
 * Distinct from a plan's `features: string[]` (free marketing copy shown
 * on /billing, e.g. "QR table ordering") — these keys are what a plan's
 * `featureKeys` references, and what the Phase 5 entitlement engine will
 * actually check server-side. A plan's marketing copy and its featureKeys
 * are edited together but are not the same list: copy can say "Everything
 * in Starter" as one bullet while featureKeys lists every key literally.
 */

export const FEATURES = {
  QR_ORDERING: "qr_ordering",
  POS_BILLING: "pos_billing",
  KDS: "kds",
  PAYMENT_GATEWAYS: "payment_gateways",
  TABLE_MANAGEMENT: "table_management",
  CASH_REGISTER: "cash_register",
  INVENTORY: "inventory",
  RECIPE_COSTING: "recipe_costing",
  SUPPLIERS_AP: "suppliers_ap",
  CUSTOMERS_LOYALTY: "customers_loyalty",
  COMBOS_COUPONS: "combos_coupons",
  RESERVATIONS: "reservations",
  EXPENSE_TRACKING: "expense_tracking",
  ACCOUNT_BOOKS: "account_books",
  PAYROLL: "payroll",
  REPORTS: "reports",
  DATA_EXPORT: "data_export",
  AI_ASSISTANT: "ai_assistant",
  WEBSITE_BUILDER: "website_builder",
  MULTI_BRANCH: "multi_branch",
  // Phase 17 (Attendance overhaul, Track B — plan-gated attendance tiers).
  // Gates only the ADVANCED attendance suite built in Phases 12-16: selfie
  // photo verification + owner review, leave/holiday management, staff
  // scheduling, and attendance analytics. Deliberately does NOT gate plain
  // clock-in/clock-out (with an optional note, no photo) — that predates
  // this feature key and every existing restaurant, on every plan, already
  // has it; retroactively paywalling something customers already use
  // wasn't part of this phase's scope. See drizzle/0066 for which plans
  // carry this key (Growth + Pro, same tier as `payroll` — attendance's
  // main integration point) and requireFeature()'s call sites in the
  // attendance/leave-requests/holidays/schedule routes for exactly which
  // endpoints check it.
  STAFF_ATTENDANCE: "staff_attendance",
} as const;

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];

export const FEATURE_DESCRIPTIONS: Record<FeatureKey, string> = {
  [FEATURES.QR_ORDERING]: "Customer-facing QR table ordering",
  [FEATURES.POS_BILLING]: "Point of sale & billing",
  [FEATURES.KDS]: "Kitchen Display System",
  [FEATURES.PAYMENT_GATEWAYS]: "eSewa & Khalti payment gateways",
  [FEATURES.TABLE_MANAGEMENT]: "Table transfer/merge/hold-resume",
  [FEATURES.CASH_REGISTER]: "Cash register & shift management, daily closing",
  [FEATURES.INVENTORY]: "Inventory, stock movements, physical counts, transfers",
  [FEATURES.RECIPE_COSTING]: "Recipe costing & COGS",
  [FEATURES.SUPPLIERS_AP]: "Suppliers & accounts payable",
  [FEATURES.CUSTOMERS_LOYALTY]: "Customer CRM, credit, loyalty program",
  [FEATURES.COMBOS_COUPONS]: "Combos & coupons",
  [FEATURES.RESERVATIONS]: "Table reservations",
  [FEATURES.EXPENSE_TRACKING]: "Expense tracking & approval workflow",
  [FEATURES.ACCOUNT_BOOKS]: "Account books ledger & reconciliation",
  [FEATURES.PAYROLL]: "Staff payroll & payslips",
  [FEATURES.REPORTS]: "Analytics & reports",
  [FEATURES.DATA_EXPORT]: "CSV data export",
  [FEATURES.AI_ASSISTANT]: "AI restaurant assistant",
  [FEATURES.WEBSITE_BUILDER]: "Public website builder",
  [FEATURES.MULTI_BRANCH]: "Multiple branches",
  [FEATURES.STAFF_ATTENDANCE]: "Staff selfie attendance, leave & scheduling",
};
