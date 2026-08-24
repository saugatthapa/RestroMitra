/**
 * Central permission catalog for RestroMitra.
 *
 * This is the single source of truth for every granular permission string
 * used across the app. API routes and server actions must check against
 * these constants — never hand-roll a permission string inline, so we
 * don't end up with silent typos that fail open.
 */

export const PERMISSIONS = {
  // Sales / orders
  VIEW_SALES: "view_sales",
  CREATE_ORDER: "create_order",
  EDIT_ORDER: "edit_order",
  CANCEL_ORDER: "cancel_order",
  REFUND_ORDER: "refund_order",
  // Phase 13 — same trust tier as REFUND_ORDER (reduces restaurant
  // revenue, needs the same accountability), not bundled into EDIT_ORDER
  // so a waiter/cashier can't quietly discount their own tables' bills.
  APPLY_DISCOUNT: "apply_discount",

  // Menu
  EDIT_MENU: "edit_menu",
  EDIT_PRICE: "edit_price",

  // Inventory
  MANAGE_INVENTORY: "manage_inventory",
  VIEW_PROFIT: "view_profit",

  // Physical Stock Count (Commercial Launch Phase A.6) — MANAGE_INVENTORY
  // already covers creating a count and entering physical quantities (the
  // day-to-day counting work an inventory_manager does). Approving a count
  // whose variance exceeds the "large variance" threshold is deliberately
  // a SEPARATE, higher-trust permission: the person who physically counted
  // the stock (and could be the one who took it) should not also be the
  // one who signs off on writing the resulting shrinkage/overage into the
  // books unchecked — a standard segregation-of-duties control. Small
  // variances auto-apply under MANAGE_INVENTORY alone; see stock-count.ts.
  APPROVE_STOCK_COUNT: "approve_stock_count",

  // Staff / org
  MANAGE_STAFF: "manage_staff",
  MANAGE_RESTAURANT_SETTINGS: "manage_restaurant_settings",
  MANAGE_BRANCHES: "manage_branches",
  MANAGE_SUBSCRIPTION: "manage_subscription",

  // Tables / floor
  MANAGE_TABLES: "manage_tables",

  // Reservations / CRM
  MANAGE_RESERVATIONS: "manage_reservations",
  MANAGE_CUSTOMERS: "manage_customers",

  // Expenses
  MANAGE_EXPENSES: "manage_expenses",
  // Phase 21 — the expense approval/payment workflow. Deliberately
  // separate from MANAGE_EXPENSES (create/edit/manage categories):
  // CREATE_EXPENSE_REQUEST is the low-trust "submit for approval" grant;
  // APPROVE_EXPENSE and PAY_EXPENSE are split per the spec's own example
  // (a manager can approve spend, but paying it out is a step higher —
  // owner/accountant only by default).
  CREATE_EXPENSE_REQUEST: "create_expense_request",
  APPROVE_EXPENSE: "approve_expense",
  PAY_EXPENSE: "pay_expense",

  // Account Books (Phase 19)
  MANAGE_ACCOUNT_BOOKS: "manage_account_books",

  // Cash Register / Shift Management (Commercial Launch Phase A.1) — split
  // the same way expense approval vs. payment is split (see PAY_EXPENSE's
  // comment): day-to-day open/close/cash-movement is a lower trust tier
  // than reopening or correcting a shift that's already closed, which
  // rewrites what was meant to be a locked financial record.
  MANAGE_CASH_REGISTER: "manage_cash_register",
  CORRECT_CASH_REGISTER: "correct_cash_register",

  // Daily Closing (Commercial Launch Phase A.2) — closing a business day
  // AND acting on financial records (e.g. a late refund) belonging to an
  // already-closed day both require this: the same trust tier the spec
  // asks for ("manager corrections must be explicitly authorized"), so
  // one permission covers both rather than adding a second that would
  // always be granted to the exact same roles.
  MANAGE_DAILY_CLOSING: "manage_daily_closing",

  // Payroll (Phase 21) — kept separate from every other financial
  // permission above: salary information must stay private (spec
  // section 31), so this is never bundled into MANAGE_EXPENSES or any
  // role that doesn't explicitly need to see pay.
  VIEW_PAYROLL: "view_payroll",
  MANAGE_PAYROLL: "manage_payroll",

  // Reports
  VIEW_REPORTS: "view_reports",

  // Kitchen
  VIEW_KDS: "view_kds",
  UPDATE_KDS_STATUS: "update_kds_status",

  // Real-time service calls ("Call staff" from the QR menu) — floor-facing,
  // so it's granted to the roles who actually walk over to a table
  // (waiter/cashier/manager/owner), not kitchen_staff/inventory_manager/
  // accountant, who have no reason to be paged for "guest needs water".
  VIEW_SERVICE_CALLS: "view_service_calls",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  [PERMISSIONS.VIEW_SALES]: "View sales figures and revenue",
  [PERMISSIONS.CREATE_ORDER]: "Create a new order (POS, waiter, QR-assisted)",
  [PERMISSIONS.EDIT_ORDER]: "Modify an existing order's items",
  [PERMISSIONS.CANCEL_ORDER]: "Cancel an order",
  [PERMISSIONS.REFUND_ORDER]: "Issue a refund on a paid order",
  [PERMISSIONS.APPLY_DISCOUNT]: "Apply a discount or set the service charge on an order",
  [PERMISSIONS.EDIT_MENU]: "Create, edit, or deactivate menu items/categories",
  [PERMISSIONS.EDIT_PRICE]: "Change menu item or variant prices",
  [PERMISSIONS.MANAGE_INVENTORY]: "Manage inventory items, stock movements, recipes",
  [PERMISSIONS.VIEW_PROFIT]: "View cost/margin and profit data",
  [PERMISSIONS.APPROVE_STOCK_COUNT]:
    "Approve or reject a physical stock count whose variance exceeds the auto-apply threshold",
  [PERMISSIONS.MANAGE_STAFF]: "Invite, edit, deactivate staff and assign roles",
  [PERMISSIONS.MANAGE_RESTAURANT_SETTINGS]: "Edit restaurant profile and settings",
  [PERMISSIONS.MANAGE_BRANCHES]: "Create and manage branches",
  [PERMISSIONS.MANAGE_SUBSCRIPTION]: "Manage billing plan and subscription",
  [PERMISSIONS.MANAGE_TABLES]: "Create/edit tables and generate QR codes",
  [PERMISSIONS.MANAGE_RESERVATIONS]: "Create and manage reservations",
  [PERMISSIONS.MANAGE_CUSTOMERS]: "View and edit customer CRM records",
  [PERMISSIONS.MANAGE_EXPENSES]: "Record and edit operational expenses, manage expense categories",
  [PERMISSIONS.CREATE_EXPENSE_REQUEST]: "Submit an expense for approval",
  [PERMISSIONS.APPROVE_EXPENSE]: "Approve or reject a pending expense",
  [PERMISSIONS.PAY_EXPENSE]: "Mark an approved expense as paid",
  [PERMISSIONS.MANAGE_ACCOUNT_BOOKS]: "View and record entries in the Account Books ledger, settle dues, and reconcile non-cash payments against bank/gateway statements",
  [PERMISSIONS.MANAGE_CASH_REGISTER]: "Open/close a cash register shift and record cash drops, additions, and payouts",
  [PERMISSIONS.CORRECT_CASH_REGISTER]: "Reopen or correct a closed cash register shift",
  [PERMISSIONS.MANAGE_DAILY_CLOSING]:
    "Close a business day's books and act on financial records from an already-closed day",
  [PERMISSIONS.VIEW_PAYROLL]: "View payroll and salary information",
  [PERMISSIONS.MANAGE_PAYROLL]: "Calculate, approve, and pay employee payroll",
  [PERMISSIONS.VIEW_REPORTS]: "View analytics and reports",
  [PERMISSIONS.VIEW_KDS]: "View the Kitchen Display System",
  [PERMISSIONS.UPDATE_KDS_STATUS]: "Update order/ticket status from the KDS",
  [PERMISSIONS.VIEW_SERVICE_CALLS]: "Receive and acknowledge \"Call staff\" alerts from tables",
};

/**
 * Default role → permission matrix. Seeded into role_permissions at
 * migration time. Platform admins bypass this matrix entirely (see
 * requireAuth/isPlatformAdmin) since they operate outside any single
 * tenant's scope.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<
  Exclude<
    | "owner"
    | "manager"
    | "cashier"
    | "waiter"
    | "kitchen_staff"
    | "inventory_manager"
    | "accountant",
    never
  >,
  PermissionKey[]
> = {
  owner: Object.values(PERMISSIONS),
  manager: [
    PERMISSIONS.VIEW_SALES,
    PERMISSIONS.CREATE_ORDER,
    PERMISSIONS.EDIT_ORDER,
    PERMISSIONS.CANCEL_ORDER,
    // Added in Phase 5: refunds gated to owner-only was unrealistic for
    // real operations — a manager routinely needs to void/refund a bill
    // without waking the owner up. Cashier/waiter still can't (they can
    // record payments via EDIT_ORDER, but reversing money needs the extra
    // trust level).
    PERMISSIONS.REFUND_ORDER,
    PERMISSIONS.APPLY_DISCOUNT,
    PERMISSIONS.EDIT_MENU,
    PERMISSIONS.MANAGE_INVENTORY,
    PERMISSIONS.VIEW_PROFIT,
    // A manager didn't do the physical count themselves (inventory_manager
    // or a staff member did), so they're the right level to sign off on a
    // large variance — same segregation-of-duties reasoning as
    // CORRECT_CASH_REGISTER below.
    PERMISSIONS.APPROVE_STOCK_COUNT,
    PERMISSIONS.MANAGE_STAFF,
    PERMISSIONS.MANAGE_TABLES,
    PERMISSIONS.MANAGE_RESERVATIONS,
    PERMISSIONS.MANAGE_CUSTOMERS,
    PERMISSIONS.MANAGE_EXPENSES,
    PERMISSIONS.CREATE_EXPENSE_REQUEST,
    // Phase 21 — matches the financial-system spec's own example exactly:
    // "Manager: can approve expense. Owner: can approve/pay expense."
    // A manager's own directly-created expenses now land as "approved,
    // awaiting payment" rather than instantly paid — PAY_EXPENSE is
    // deliberately NOT granted here. This narrows what manager could do
    // yesterday (create = instantly done); see the Phase 21 commit for
    // the full reasoning.
    PERMISSIONS.APPROVE_EXPENSE,
    // Same trust tier as MANAGE_EXPENSES — a manager routinely needs to
    // log cash sales/dues without waking the owner, but cashier/waiter
    // don't get it by default (see their lists below), same reasoning as
    // MANAGE_EXPENSES not being on those roles either.
    PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
    // A manager routinely opens/closes the till and is also the person
    // trusted to correct a closed shift (see CORRECT_CASH_REGISTER's own
    // comment) — same trust pairing as APPROVE_EXPENSE/PAY_EXPENSE above.
    PERMISSIONS.MANAGE_CASH_REGISTER,
    PERMISSIONS.CORRECT_CASH_REGISTER,
    PERMISSIONS.MANAGE_DAILY_CLOSING,
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.VIEW_KDS,
    PERMISSIONS.VIEW_SERVICE_CALLS,
  ],
  cashier: [
    PERMISSIONS.CREATE_ORDER,
    PERMISSIONS.EDIT_ORDER,
    PERMISSIONS.MANAGE_CUSTOMERS,
    PERMISSIONS.VIEW_SERVICE_CALLS,
    // The role that actually runs the till day to day — open/close/record
    // cash movements, but NOT correct a shift after it's closed (that
    // needs a manager/accountant/owner, see CORRECT_CASH_REGISTER).
    PERMISSIONS.MANAGE_CASH_REGISTER,
    // Reservations are a front-desk task (answering the phone, walk-ins
    // asking to book ahead) same trust level as the CRM grant just above
    // — not money/profit-sensitive the way MANAGE_EXPENSES is, so cashier
    // gets it by default while waiter (floor-focused) does not.
    PERMISSIONS.MANAGE_RESERVATIONS,
    // Phase 21 — a cashier is the front-of-house role most likely to need
    // petty-cash reimbursement (a supply run, a delivery tip) — can
    // submit a request, cannot approve or pay it themselves.
    PERMISSIONS.CREATE_EXPENSE_REQUEST,
  ],
  waiter: [PERMISSIONS.CREATE_ORDER, PERMISSIONS.EDIT_ORDER, PERMISSIONS.VIEW_SERVICE_CALLS],
  kitchen_staff: [PERMISSIONS.VIEW_KDS, PERMISSIONS.UPDATE_KDS_STATUS],
  inventory_manager: [
    PERMISSIONS.MANAGE_INVENTORY,
    PERMISSIONS.VIEW_PROFIT,
    // Phase 21 — the role most likely submitting supply/equipment expense
    // requests; same request-only trust level as cashier above.
    PERMISSIONS.CREATE_EXPENSE_REQUEST,
    // Deliberately NOT APPROVE_STOCK_COUNT — this is the role that most
    // often performs the physical count itself, so letting it also
    // approve its own large-variance write-offs would defeat the
    // segregation-of-duties point of the permission (see its own comment
    // above manager's grant).
  ],
  // Phase 21 — a role trusted with money/reports but not floor
  // operations: financial management, expense approval + payment,
  // payroll, and reports, WITHOUT manager's operational reach
  // (no MANAGE_STAFF, MANAGE_INVENTORY, MANAGE_TABLES, MANAGE_RESERVATIONS,
  // EDIT_MENU, refunds/discounts). Matches the spec's own "ACCOUNTANT:
  // Financial management, Payroll, Reports" example.
  accountant: [
    PERMISSIONS.VIEW_SALES,
    PERMISSIONS.VIEW_PROFIT,
    PERMISSIONS.MANAGE_EXPENSES,
    PERMISSIONS.CREATE_EXPENSE_REQUEST,
    PERMISSIONS.APPROVE_EXPENSE,
    PERMISSIONS.PAY_EXPENSE,
    PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
    PERMISSIONS.VIEW_PAYROLL,
    PERMISSIONS.MANAGE_PAYROLL,
    PERMISSIONS.VIEW_REPORTS,
    // Financial-management role — trusted with correcting a closed
    // register shift's numbers same as a manager, per spec section 6.
    PERMISSIONS.MANAGE_CASH_REGISTER,
    PERMISSIONS.CORRECT_CASH_REGISTER,
    PERMISSIONS.MANAGE_DAILY_CLOSING,
    // A financial-oversight role, not the one doing the physical count —
    // same segregation-of-duties reasoning as manager's grant above.
    PERMISSIONS.APPROVE_STOCK_COUNT,
  ],
};

/**
 * Checks whether `role` has `permission`, against the default role→
 * permission matrix above. Owner and platform_admin bypass the matrix
 * entirely (same rule as the API layer's `guard.ts`), since they operate
 * with full tenant/platform access regardless of what's in the table.
 *
 * This used to be redefined identically at the top of every
 * `/dashboard/*` page.tsx that needed a permission check — one shared copy
 * now, imported everywhere (including client components like
 * DashboardShell, since this module has no `"server-only"` import and is
 * just plain data + a pure function).
 */
export function roleHasPermission(role: string, permission: PermissionKey): boolean {
  if (role === "platform_admin" || role === "owner") return true;
  const granted = DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS];
  return granted?.includes(permission) ?? false;
}
