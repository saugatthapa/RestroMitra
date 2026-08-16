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

  // Account Books (Phase 19)
  MANAGE_ACCOUNT_BOOKS: "manage_account_books",

  // Reports
  VIEW_REPORTS: "view_reports",

  // Kitchen
  VIEW_KDS: "view_kds",
  UPDATE_KDS_STATUS: "update_kds_status",
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
  [PERMISSIONS.MANAGE_STAFF]: "Invite, edit, deactivate staff and assign roles",
  [PERMISSIONS.MANAGE_RESTAURANT_SETTINGS]: "Edit restaurant profile and settings",
  [PERMISSIONS.MANAGE_BRANCHES]: "Create and manage branches",
  [PERMISSIONS.MANAGE_SUBSCRIPTION]: "Manage billing plan and subscription",
  [PERMISSIONS.MANAGE_TABLES]: "Create/edit tables and generate QR codes",
  [PERMISSIONS.MANAGE_RESERVATIONS]: "Create and manage reservations",
  [PERMISSIONS.MANAGE_CUSTOMERS]: "View and edit customer CRM records",
  [PERMISSIONS.MANAGE_EXPENSES]: "Record and edit operational expenses",
  [PERMISSIONS.MANAGE_ACCOUNT_BOOKS]: "View and record entries in the Account Books ledger, settle dues",
  [PERMISSIONS.VIEW_REPORTS]: "View analytics and reports",
  [PERMISSIONS.VIEW_KDS]: "View the Kitchen Display System",
  [PERMISSIONS.UPDATE_KDS_STATUS]: "Update order/ticket status from the KDS",
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
    | "inventory_manager",
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
    PERMISSIONS.MANAGE_STAFF,
    PERMISSIONS.MANAGE_TABLES,
    PERMISSIONS.MANAGE_RESERVATIONS,
    PERMISSIONS.MANAGE_CUSTOMERS,
    PERMISSIONS.MANAGE_EXPENSES,
    // Same trust tier as MANAGE_EXPENSES — a manager routinely needs to
    // log cash sales/dues without waking the owner, but cashier/waiter
    // don't get it by default (see their lists below), same reasoning as
    // MANAGE_EXPENSES not being on those roles either.
    PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.VIEW_KDS,
  ],
  cashier: [
    PERMISSIONS.CREATE_ORDER,
    PERMISSIONS.EDIT_ORDER,
    PERMISSIONS.MANAGE_CUSTOMERS,
    // Reservations are a front-desk task (answering the phone, walk-ins
    // asking to book ahead) same trust level as the CRM grant just above
    // — not money/profit-sensitive the way MANAGE_EXPENSES is, so cashier
    // gets it by default while waiter (floor-focused) does not.
    PERMISSIONS.MANAGE_RESERVATIONS,
  ],
  waiter: [PERMISSIONS.CREATE_ORDER, PERMISSIONS.EDIT_ORDER],
  kitchen_staff: [PERMISSIONS.VIEW_KDS, PERMISSIONS.UPDATE_KDS_STATUS],
  inventory_manager: [PERMISSIONS.MANAGE_INVENTORY, PERMISSIONS.VIEW_PROFIT],
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
