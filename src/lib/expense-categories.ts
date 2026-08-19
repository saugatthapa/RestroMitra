/**
 * Default expense categories — Phase 21. Superseded the old fixed
 * 8-value `expense_category` Postgres enum (Phase 8c) with a real
 * per-restaurant `expense_categories` table, so an owner can add their
 * own categories at runtime instead of being stuck with a hardcoded list
 * (an explicitly documented "known gap" from Phase 8c).
 *
 * This module is now just the SEED list — the list every restaurant
 * starts with (matching the financial-system spec's section 5) — plus a
 * helper to seed it for one restaurant. The actual category catalog a
 * given restaurant has access to always comes from the database
 * (expense_categories rows), never from this static array, since a
 * restaurant may have renamed/deactivated/added to its own copy.
 *
 * Existing restaurants got this exact same list backfilled by migration
 * 0021 — keep this array and that migration's VALUES list in sync if
 * either ever changes, though in practice neither should: new categories
 * from here on are meant to be added by restaurant owners themselves via
 * the expense-categories API, not by editing this seed list.
 */
import type { Transaction } from "@/db";
import { expenseCategories } from "@/db/schema";

export const DEFAULT_EXPENSE_CATEGORY_NAMES = [
  "Payroll",
  "Inventory",
  "Food ingredients",
  "Beverages",
  "Rent",
  "Utilities",
  "Electricity",
  "Water",
  "Internet",
  "Gas",
  "Maintenance",
  "Equipment",
  "Cleaning",
  "Packaging",
  "Transportation",
  "Delivery",
  "Marketing",
  "Advertising",
  "Software",
  "Taxes",
  "Bank charges",
  "Payment gateway fees",
  "Office expenses",
  "Miscellaneous",
] as const;

/**
 * Seeds the default category list for a newly-onboarded restaurant —
 * called once from the onboarding route, right after the restaurant row
 * is created. `onConflictDoNothing` makes this safe to call more than
 * once for the same restaurant (matches the unique index on
 * (restaurant_id, name)) without erroring.
 */
export async function seedDefaultExpenseCategories(tx: Transaction, restaurantId: string) {
  await tx
    .insert(expenseCategories)
    .values(
      DEFAULT_EXPENSE_CATEGORY_NAMES.map((name, index) => ({
        restaurantId,
        name,
        sortOrder: index,
      })),
    )
    .onConflictDoNothing();
}
