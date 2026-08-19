/**
 * The subset of system_role values that can be assigned to a staff member
 * through the "Add staff" / "Change role" UI. Deliberately excludes:
 *  - "owner" — ownership isn't reassigned through this flow (a bigger,
 *    more deliberate action deserving its own confirmation flow, not a
 *    role dropdown); the account that completed onboarding stays owner.
 *  - "platform_admin" — cross-tenant support role, not restaurant-scoped,
 *    never assigned by a restaurant's own staff.
 * Dependency-free (no "server-only", no DB import) so it's shared,
 * unmodified, between Zod validation, API routes, and the dashboard UI —
 * same pattern as PAYMENT_METHODS / INVENTORY_UNITS.
 */

export const ASSIGNABLE_STAFF_ROLES = [
  "manager",
  "cashier",
  "waiter",
  "kitchen_staff",
  "inventory_manager",
  // Phase 21 — financial system: a role trusted with money/reports but
  // not floor operations (expense approval/payment, payroll, account
  // books, reports). See DEFAULT_ROLE_PERMISSIONS for the exact grant.
  "accountant",
] as const;

export type AssignableStaffRole = (typeof ASSIGNABLE_STAFF_ROLES)[number];

export const STAFF_ROLE_LABELS: Record<AssignableStaffRole, string> = {
  manager: "Manager",
  cashier: "Cashier",
  waiter: "Waiter",
  kitchen_staff: "Kitchen Staff",
  inventory_manager: "Inventory Manager",
  accountant: "Accountant",
};
