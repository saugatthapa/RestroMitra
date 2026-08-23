import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  date,
  bigserial,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/**
 * RestroMitra — Phase 1 schema
 * Foundation: users, restaurants, branches, roles, permissions, sessions.
 *
 * Multi-tenancy rule (enforced in application code, not just here):
 * every tenant-owned row carries restaurant_id (and branch_id where
 * relevant). Tenant identity is ALWAYS derived server-side from the
 * authenticated session — never trusted from client input.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const restaurantTypeEnum = pgEnum("restaurant_type", [
  "cafe",
  "restaurant",
  "fast_food",
  "momo_shop",
  "bar",
  "hotel_restaurant",
  "bakery",
  "other",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
]);

// Phase 10 — the fixed plan catalog. A code-defined set (src/lib/plans.ts),
// same "enum, not a table" reasoning as expense_category: pricing/limits
// change rarely enough that a DB-editable plans table would be more
// machinery than this app needs before there's even a payment gateway
// (that's Phase 11's job) to actually charge for one.
export const planKeyEnum = pgEnum("plan_key", ["starter", "growth", "pro"]);

// Every state transition a restaurant's subscription goes through, logged
// to subscription_events below — the same ledger-over-mutable-field
// pattern as payments/stock_movements/loyalty_transactions elsewhere in
// this schema, so "how did this restaurant get here" is always
// reconstructable, not just the current snapshot on the restaurants row.
export const subscriptionEventTypeEnum = pgEnum("subscription_event_type", [
  "trial_started",
  "trial_extended",
  "trial_expired",
  "upgrade_requested",
  "plan_assigned",
  "plan_changed",
  "activated",
  "past_due_marked",
  "cancelled",
  "reactivated",
]);

export const systemRoleEnum = pgEnum("system_role", [
  "platform_admin",
  "owner",
  "manager",
  "cashier",
  "waiter",
  "kitchen_staff",
  "inventory_manager",
  // Financial system (Phase 21) — a role trusted with money/reports but
  // not floor operations: payroll, expense approval/payment, account
  // books, and reports, without the operational reach of "manager"
  // (no MANAGE_STAFF, MANAGE_INVENTORY, MANAGE_TABLES, etc.). See
  // DEFAULT_ROLE_PERMISSIONS for the exact grant.
  "accountant",
]);

// Phase 3 — an order's lifecycle. Deliberately small/linear for now: the
// full state machine (splits, merges, partial refunds, void-with-reason
// etc.) is Phase 4/5 (order engine, POS) territory. "pending" is the only
// status this phase's code creates (a freshly-submitted QR order); the
// rest exist now so the schema doesn't need another migration the moment
// staff-side order management (Phase 4) starts transitioning them.
export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "served",
  "completed",
  "cancelled",
]);

// Where an order originated. Only "qr_customer" is produced by Phase 3;
// "pos" and "waiter" are reserved for Phase 4/5 so the column doesn't need
// widening later.
export const orderSourceEnum = pgEnum("order_source", [
  "qr_customer",
  "pos",
  "waiter",
]);

// Phase 5 — billing. paymentStatus is DERIVED (see src/lib/payments.ts
// computePaymentStatus) from the sum of that order's payment rows, then
// cached on the order for fast list rendering — it is never set directly
// by client input, only recomputed server-side after each payment/refund.
export const paymentStatusEnum = pgEnum("payment_status", [
  "unpaid",
  "partially_paid",
  "paid",
]);

// Phase 13 — discounts/service charge/tips. A discount is either a flat
// paisa amount off, or a percentage (stored as basis points, see
// discountValue on `orders` below) — never both at once for the same
// order (src/lib/order-adjustments.ts enforces this).
export const discountTypeEnum = pgEnum("discount_type", ["percentage", "flat"]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "card",
  "mobile_wallet",
  "other",
]);

// Phase 11c — Payment gateway integrations. Both are Nepal digital-wallet
// gateways with a similar shape (redirect the customer to a hosted payment
// page, verify the result server-side, then record it through the SAME
// `payments` table every other payment method uses — method: "mobile_wallet",
// see PAYMENT_METHOD_LABELS). This table is the pending/in-flight ledger for
// that redirect round trip; it is NOT a replacement for `payments` — a
// successful gateway transaction always ends by inserting a normal
// `payments` row (paymentId below links back to it) so refunds, billing
// summaries, and reports never need to know a payment came from a gateway
// at all.
export const paymentGatewayEnum = pgEnum("payment_gateway", ["esewa", "khalti"]);
export const paymentGatewayTransactionStatusEnum = pgEnum(
  "payment_gateway_transaction_status",
  ["initiated", "completed", "failed", "cancelled"],
);

// ---------------------------------------------------------------------------
// Platform-level: users (a user is a person; can belong to multiple
// restaurants via user_roles, e.g. an owner of two restaurants, or staff
// who works at one). Platform admins are users with a platform_admin role
// row that has no restaurant_id.
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    phone: varchar("phone", { length: 20 }).notNull(),
    email: varchar("email", { length: 255 }),
    passwordHash: text("password_hash").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_phone_unique").on(table.phone),
    uniqueIndex("users_email_unique").on(table.email),
  ],
);

// Sessions — server-side session store (not pure JWT) so we can revoke
// instantly (logout everywhere, staff removal, etc.)
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    activeRestaurantId: uuid("active_restaurant_id").references(
      () => restaurants.id,
      { onDelete: "set null" },
    ),
    userAgent: text("user_agent"),
    ipAddress: varchar("ip_address", { length: 64 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// Tenant root: restaurants + branches
// ---------------------------------------------------------------------------

export const restaurants = pgTable(
  "restaurants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 120 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    logoUrl: text("logo_url"),
    // Phase 17 — printed at the top of every Kitchen Order Ticket (see
    // src/lib/kot.ts), instead of always hardcoding the restaurant's legal
    // name — e.g. a shorter kitchen-facing name, or a branch-specific line.
    // Null/empty falls back to `name` at render time (see buildKotTicket).
    kotHeaderText: varchar("kot_header_text", { length: 200 }),
    type: restaurantTypeEnum("type").notNull().default("restaurant"),
    panVat: varchar("pan_vat", { length: 40 }),
    phone: varchar("phone", { length: 20 }),
    address: text("address"),
    city: varchar("city", { length: 100 }),
    district: varchar("district", { length: 100 }),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Kathmandu"),
    currency: varchar("currency", { length: 8 }).notNull().default("NPR"),
    defaultLocale: varchar("default_locale", { length: 8 }).notNull().default("en"),
    openingHours: jsonb("opening_hours").$type<Record<string, { open: string; close: string } | null>>(),
    onboardingStep: integer("onboarding_step").notNull().default(1),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    subscriptionStatus: subscriptionStatusEnum("subscription_status")
      .notNull()
      .default("trialing"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    // Phase 10 — nullable: a restaurant on its free trial hasn't committed
    // to a plan yet (see src/lib/plans.ts's TRIAL_MAX_STAFF for the limits
    // that apply in the meantime). Set once a platform admin assigns/
    // activates a plan (src/app/api/admin/restaurants/[id]/subscription).
    planKey: planKeyEnum("plan_key"),
    // Phase 25c — price grandfathering. Null means "use whatever
    // src/lib/plans.ts's catalog currently charges for planKey" (the
    // normal case, including every brand-new plan assignment). Set only
    // when a restaurant was already paying a price the catalog has since
    // moved on from — e.g. the Aug 2026 Growth reprice (Rs 1,799 → Rs
    // 1,399/mo) locked every restaurant already on Growth at Rs 1,799/mo
    // so a live catalog price cut never silently changes what an existing
    // customer is actually being billed. Cleared back to null whenever a
    // platform admin makes a fresh assign_plan call (see the admin
    // subscription route) — a new assignment always means "charge
    // whatever the catalog says today," never "keep the old lock." See
    // src/lib/plans.ts's getEffectivePlan().
    lockedMonthlyPriceInPaisa: integer("locked_monthly_price_in_paisa"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("restaurants_slug_unique").on(table.slug)],
);

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 150 }).notNull(),
    address: text("address"),
    city: varchar("city", { length: 100 }),
    phone: varchar("phone", { length: 20 }),
    isMain: boolean("is_main").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("branches_restaurant_id_idx").on(table.restaurantId)],
);

// ---------------------------------------------------------------------------
// RBAC: roles, permissions, role_permissions, user_roles
// Roles are a fixed system enum for Phase 1 (custom roles can come later).
// Permissions are granular strings checked server-side on every request.
// ---------------------------------------------------------------------------

export const permissions = pgTable("permissions", {
  key: varchar("key", { length: 64 }).primaryKey(), // e.g. "view_sales"
  description: text("description").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    role: systemRoleEnum("role").notNull(),
    permissionKey: varchar("permission_key", { length: 64 })
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.role, table.permissionKey] })],
);

// A user_role row grants `role` to `userId` scoped to a restaurant
// (and optionally a specific branch). Platform admins have restaurantId
// = NULL. This is the single source of truth for "what can this user
// do, where" — every API route must resolve authorization through this
// table, never through client-supplied identifiers.
export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    restaurantId: uuid("restaurant_id").references(() => restaurants.id, {
      onDelete: "cascade",
    }),
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    role: systemRoleEnum("role").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("user_roles_user_id_idx").on(table.userId),
    index("user_roles_restaurant_id_idx").on(table.restaurantId),
    uniqueIndex("user_roles_unique_scope").on(
      table.userId,
      table.restaurantId,
      table.branchId,
      table.role,
    ),
    // At most one ACTIVE grant per (user, restaurant) — see the staff
    // POST route's own comment: the rest of the app (requireRestaurantAccess's
    // single-row lookup, the dashboard's `role` display, branch scoping)
    // assumes exactly one active role per person per restaurant, and a
    // second active grant would make "which one wins" ambiguous rather
    // than additive. The staff-add route already checked for this before
    // inserting, but the staff PATCH route's reactivation path (isActive:
    // true on a previously-deactivated grant) did NOT check for another
    // already-active grant on the same user+restaurant first — this index
    // is the actual backstop that makes the invariant hold everywhere,
    // present and future, not just at the one call site that happened to
    // remember to check. Partial (WHERE is_active) so a user can freely
    // accumulate deactivated history rows (removed, re-added elsewhere,
    // etc.) — only concurrently-ACTIVE rows are constrained. Excludes
    // restaurantId IS NULL (platform_admin grants, which aren't scoped to
    // one restaurant) since a unique index never treats multiple NULLs as
    // colliding.
    uniqueIndex("user_roles_one_active_per_restaurant_unique")
      .on(table.userId, table.restaurantId)
      .where(sql`${table.isActive} = true AND ${table.restaurantId} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Phase 2 — Menu: kitchen stations, categories, menu items, variants,
// add-ons.
//
// Money handling: every price/tax-rate column below is an INTEGER counted
// in paisa (1/100 NPR), never a float/decimal. This sidesteps binary
// floating-point rounding error entirely rather than trying to be careful
// with it. `priceInPaisa` of 18000 == Rs. 180.00. Helpers for formatting
// live in src/lib/money.ts.
//
// Menu is restaurant-level (not per-branch) for Phase 2 — every branch of
// a restaurant shares one menu. Per-branch menu overrides (e.g. a branch
// temporarily out of an item) can be layered on later without a schema
// rewrite (an optional branch_menu_item_overrides table), so we're not
// painted into a corner, but we're also not building it before anyone
// needs it.
// ---------------------------------------------------------------------------

export const kitchenStations = pgTable(
  "kitchen_stations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(), // e.g. "Momo Station", "Bar"
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("kitchen_stations_restaurant_id_idx").on(table.restaurantId)],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(), // e.g. "MOMO", "DRINKS"
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("categories_restaurant_id_idx").on(table.restaurantId)],
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    kitchenStationId: uuid("kitchen_station_id").references(
      () => kitchenStations.id,
      { onDelete: "set null" },
    ),
    name: varchar("name", { length: 150 }).notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    sku: varchar("sku", { length: 60 }),
    // Base price in paisa. Ignored for ordering purposes if the item has
    // one or more variants (see menuVariants) — a variant's own price
    // applies instead. Kept even when variants exist so "revert to no
    // variants" doesn't lose the base price.
    basePriceInPaisa: integer("base_price_in_paisa").notNull(),
    // Tax rate in basis points (1/100 of a percent) so e.g. 13.00% VAT is
    // stored as an exact integer 1300, not a float 13.0. Configurable per
    // item rather than hardcoded, per the product spec's tax requirements.
    taxRateBasisPoints: integer("tax_rate_basis_points").notNull().default(0),
    prepTimeMinutes: integer("prep_time_minutes"),
    isAvailable: boolean("is_available").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("menu_items_restaurant_id_idx").on(table.restaurantId),
    index("menu_items_category_id_idx").on(table.categoryId),
  ],
);

export const menuVariants = pgTable(
  "menu_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 60 }).notNull(), // e.g. "Small" / "Medium" / "Large"
    priceInPaisa: integer("price_in_paisa").notNull(), // absolute price, not a delta
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("menu_variants_menu_item_id_idx").on(table.menuItemId)],
);

export const menuAddons = pgTable(
  "menu_addons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(), // e.g. "Extra spicy"
    priceInPaisa: integer("price_in_paisa").notNull().default(0),
    isAvailable: boolean("is_available").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("menu_addons_menu_item_id_idx").on(table.menuItemId)],
);

// ---------------------------------------------------------------------------
// Phase 3 — Tables + QR ordering.
//
// A table belongs to exactly one branch and carries a high-entropy,
// unguessable `qrToken` — the ONLY way the public /order/[token] page
// resolves a table. Tokens are never sequential/derivable from a table id,
// so a customer at table 3 can't guess table 4's link and place an order
// there. Tables are soft-deleted (isActive) like everything else, so
// historical orders keep resolving to a real table row.
//
// Orders created here (source = "qr_customer") are intentionally minimal:
// no payment, no staff-side status transitions beyond the "pending" they're
// born in, no KDS routing. That's Phase 4 (centralized order engine) and
// Phase 6 (KDS) — this phase proves the QR -> menu -> cart -> submitted
// order pipeline end to end with server-computed, tamper-proof pricing,
// which every later phase builds on rather than redoing.
//
// Every price on an order/order_item/order_item_addon is a SNAPSHOT taken
// at submission time (name + price copied from the menu row), not a live
// reference. Menu prices change over time; a bill for an order placed
// yesterday must keep showing yesterday's price even if today's menu is
// different. The optional FK back to the source menu row is kept only for
// traceability (e.g. "what does this map to today"), never for pricing.
//
// Phase 12 — table status + floor plan. `status` is the table's CURRENT
// physical/operational state, mostly derived automatically from order and
// reservation activity (see src/lib/tables.ts's deriveTableStatus() —
// occupied while any order on this table is still kitchen-active, then
// payment_pending once everything's served but nothing's completed yet,
// then cleaning once the last order completes, then released back to
// available). `cleaning` -> `available` and anything <-> `out_of_service`
// are the only two MANUAL transitions a staff member drives directly (see
// src/lib/table-status.ts's canManuallyTransition()) — everything else is
// system-driven so the floor plan reflects reality without staff having to
// remember to update it by hand. `posX`/`posY`/`width`/`height`/`shape`/
// `rotation` are the floor-plan layout a manager arranges via drag-and-drop;
// `floorLabel` groups tables into sections/floors (e.g. "Ground Floor",
// "Rooftop") purely for filtering the floor-plan view, not a separate table.
// ---------------------------------------------------------------------------

export const tableStatusEnum = pgEnum("table_status", [
  "available",
  "ordering",
  "occupied",
  "reserved",
  "payment_pending",
  "cleaning",
  "out_of_service",
]);

export const tableShapeEnum = pgEnum("table_shape", ["rectangle", "circle", "square"]);

export const restaurantTables = pgTable(
  "restaurant_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 50 }).notNull(), // e.g. "Table 5", "T-12"
    capacity: integer("capacity"),
    // High-entropy random token embedded in the QR code's URL
    // (/order/[qrToken]). Never guessable/sequential — see comment above.
    qrToken: varchar("qr_token", { length: 64 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    status: tableStatusEnum("status").notNull().default("available"),
    // Floor-plan layout — nullable so existing/newly-created tables render
    // somewhere sane (a default grid, computed client-side) before a
    // manager has ever opened the drag-and-drop editor.
    posX: integer("pos_x"),
    posY: integer("pos_y"),
    width: integer("width").notNull().default(100),
    height: integer("height").notNull().default(100),
    shape: tableShapeEnum("shape").notNull().default("rectangle"),
    rotation: integer("rotation").notNull().default(0),
    floorLabel: varchar("floor_label", { length: 50 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("restaurant_tables_restaurant_id_idx").on(table.restaurantId),
    index("restaurant_tables_branch_id_idx").on(table.branchId),
    index("restaurant_tables_status_idx").on(table.status),
    uniqueIndex("restaurant_tables_qr_token_unique").on(table.qrToken),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    tableId: uuid("table_id").references(() => restaurantTables.id, {
      onDelete: "set null",
    }),
    // Human-facing order number, unique per restaurant (not globally) —
    // e.g. "20260814-A3F9". See src/lib/orders.ts for generation.
    orderNumber: varchar("order_number", { length: 30 }).notNull(),
    source: orderSourceEnum("source").notNull().default("qr_customer"),
    status: orderStatusEnum("status").notNull().default("pending"),
    // Independent of `status` on purpose: a served/completed order can
    // still be unpaid (pay-at-end dining), and a pending order can already
    // be fully paid (pay-ahead QR ordering, once that's wired up). Service
    // progress and billing progress are two different axes.
    paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
    customerName: varchar("customer_name", { length: 150 }),
    customerPhone: varchar("customer_phone", { length: 20 }),
    // Optional link to a Phase 8 CRM record — nullable, "set null" on
    // delete, deliberately NOT required: a guest/anonymous QR order still
    // just uses the free-text customerName/customerPhone snapshot columns
    // above. Only staff/POS order creation currently offers linking a
    // known customer (see src/lib/validation/orders.ts); when set, this is
    // what drives loyalty point earning on the order's confirmed→...→
    // completed transition (src/lib/loyalty.ts).
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    notes: text("notes"),
    // Phase 11b (offline POS), extended P0-2 to the public QR order route: a
    // client-generated id the submitting client attaches to an order it may
    // retry — e.g. a network hiccup mid-submit, an order queued locally
    // while offline and synced once back online, or a guest's phone
    // retrying a QR order after a flaky connection. When set, a retry with
    // the SAME clientRequestId returns the original order instead of
    // creating a duplicate (see the unique index below and both order POST
    // routes' idempotent-insert handling). Nullable: a submission with no
    // retry concern (or a client too old to send one) never sets this.
    clientRequestId: varchar("client_request_id", { length: 100 }),
    // All amounts here are integer paisa, computed server-side — never
    // trust a client-supplied total. subtotalInPaisa/taxInPaisa come from
    // computeOrderPricing() (menu-price snapshots), unchanged since Phase 3.
    subtotalInPaisa: integer("subtotal_in_paisa").notNull(),
    taxInPaisa: integer("tax_in_paisa").notNull(),
    // Phase 13 — discount, applied against subtotalInPaisa only (not tax,
    // not service charge — see src/lib/order-adjustments.ts's doc comment
    // for the full pricing policy and why). discountType/discountValue are
    // the STAFF INPUT (percentage in basis points, or a flat paisa amount);
    // discountInPaisa is the resulting computed/clamped amount, stored so
    // every reader (receipts, reports) uses one authoritative number
    // without re-deriving it. Null discountType = no discount on this order.
    discountType: discountTypeEnum("discount_type"),
    discountValue: integer("discount_value"),
    discountInPaisa: integer("discount_in_paisa").notNull().default(0),
    discountReason: varchar("discount_reason", { length: 300 }),
    // Phase 13 — service charge, a percentage of subtotalInPaisa (basis
    // points, e.g. 1000 = 10%). serviceChargeInPaisa is the computed/stored
    // amount, same "store the derived number" reasoning as discountInPaisa.
    serviceChargeBasisPoints: integer("service_charge_basis_points").notNull().default(0),
    serviceChargeInPaisa: integer("service_charge_in_paisa").notNull().default(0),
    // totalInPaisa = subtotalInPaisa - discountInPaisa + serviceChargeInPaisa
    // + taxInPaisa (see computeOrderTotals in order-adjustments.ts — the
    // single place this formula is allowed to live).
    totalInPaisa: integer("total_in_paisa").notNull(),
    // Phase 17 — Kitchen Order Ticket. kotSequence is a small, human-facing
    // "ticket #N" counter that resets every day (see kot_counters below and
    // assignKotSequence in src/lib/kot.ts) — deliberately NOT orderNumber
    // (a globally-unique, date-prefixed identifier meant for receipts/
    // lookups, not for a cashier to shout across a kitchen). Assigned once,
    // the first time a KOT is generated for this order — see kotPrintedAt.
    // Both null until that happens; an order that's cancelled before ever
    // reaching the kitchen (pending -> cancelled) never gets either.
    kotSequence: integer("kot_sequence"),
    kotPrintedAt: timestamp("kot_printed_at", { withTimezone: true }),
    placedAt: timestamp("placed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("orders_restaurant_id_idx").on(table.restaurantId),
    index("orders_branch_id_idx").on(table.branchId),
    index("orders_table_id_idx").on(table.tableId),
    index("orders_status_idx").on(table.status),
    uniqueIndex("orders_restaurant_order_number_unique").on(
      table.restaurantId,
      table.orderNumber,
    ),
    // Partial: most orders never set clientRequestId, so this only
    // constrains the rows that actually opt into idempotent retry/offline
    // sync (see the column comment above).
    uniqueIndex("orders_restaurant_client_request_id_unique")
      .on(table.restaurantId, table.clientRequestId)
      .where(sql`${table.clientRequestId} IS NOT NULL`),
  ],
);

// Phase 17 — backs orders.kotSequence: one row per (restaurant, day),
// atomically incremented via an upsert (`ON CONFLICT ... DO UPDATE SET
// last_number = last_number + 1 RETURNING last_number`, see
// assignKotSequence in src/lib/kot.ts) so two tickets printing at the same
// moment can never be handed the same number. ticketDate is a plain
// YYYY-MM-DD string (not a timestamp) — same UTC-calendar-day
// simplification the rest of the app uses (see reports.ts's dayBounds
// comment) — deliberately NOT reusing orders.placedAt's date, since the
// counter must exist before the first ticket of the day does.
export const kotCounters = pgTable(
  "kot_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    ticketDate: varchar("ticket_date", { length: 10 }).notNull(),
    lastNumber: integer("last_number").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("kot_counters_restaurant_date_unique").on(table.restaurantId, table.ticketDate),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // Traceability only — see schema-level comment. Never read for pricing.
    menuItemId: uuid("menu_item_id").references(() => menuItems.id, {
      onDelete: "set null",
    }),
    menuItemNameSnapshot: varchar("menu_item_name_snapshot", { length: 150 }).notNull(),
    variantId: uuid("variant_id").references(() => menuVariants.id, {
      onDelete: "set null",
    }),
    variantNameSnapshot: varchar("variant_name_snapshot", { length: 60 }),
    // Phase 6 — KDS: snapshotted at order time from the menu item's current
    // kitchen station, same reasoning as menuItemNameSnapshot above — a
    // station rename, reassignment, or deletion after the order was placed
    // must never rewrite which kitchen already-placed tickets show up on.
    // Traceability only via kitchenStationId; kitchenStationNameSnapshot is
    // what the KDS board actually displays/groups by.
    kitchenStationId: uuid("kitchen_station_id").references(() => kitchenStations.id, {
      onDelete: "set null",
    }),
    kitchenStationNameSnapshot: varchar("kitchen_station_name_snapshot", { length: 100 }),
    unitPriceInPaisa: integer("unit_price_in_paisa").notNull(),
    quantity: integer("quantity").notNull().default(1),
    lineSubtotalInPaisa: integer("line_subtotal_in_paisa").notNull(), // unitPrice * quantity
    addonsTotalInPaisa: integer("addons_total_in_paisa").notNull().default(0),
    lineTotalInPaisa: integer("line_total_in_paisa").notNull(), // subtotal + addons
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("order_items_order_id_idx").on(table.orderId)],
);

export const orderItemAddons = pgTable(
  "order_item_addons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "cascade" }),
    addonId: uuid("addon_id").references(() => menuAddons.id, {
      onDelete: "set null",
    }),
    nameSnapshot: varchar("name_snapshot", { length: 100 }).notNull(),
    priceInPaisaSnapshot: integer("price_in_paisa_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("order_item_addons_order_item_id_idx").on(table.orderItemId)],
);

// ---------------------------------------------------------------------------
// Phase 5 — Billing: payments (and, via negative amounts, refunds).
//
// A ledger, not a single "amount paid" field: `amountInPaisa` is positive
// for a payment, negative for a refund. An order's total paid is the SUM of
// its payment rows — see src/lib/payments.ts. This is also how split bills
// work: two customers splitting one order's total each get their own
// payment row (e.g. Rs 300 cash + Rs 200 card), no separate "split" concept
// needed. Item-level splitting (assigning specific items to each payer,
// rather than just an amount) is NOT built — see PHASE_5_NOTES.md.
//
// `restaurantId` is denormalized onto every payment row (technically
// derivable via orderId -> orders.restaurantId) so tenant-isolation checks
// and queries can scope directly on payments without an extra join —
// consistent with how every other tenant-owned table in this schema
// carries restaurant_id directly rather than only through a parent.
// ---------------------------------------------------------------------------

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // Positive = payment, negative = refund. Never a client-supplied order
    // total — always <= the order's remaining due at insert time (payments)
    // or <= the net paid so far (refunds), enforced in the API route.
    amountInPaisa: integer("amount_in_paisa").notNull(),
    method: paymentMethodEnum("method").notNull(),
    // Cash tendered by the customer, if more than the amount applied to
    // the order (used only to display change due — never affects the
    // order's paid total, which is `amountInPaisa`).
    receivedInPaisa: integer("received_in_paisa"),
    // Phase 13 — gratuity collected alongside this payment (e.g. a Rs 350
    // card swipe = Rs 300 toward the bill + Rs 50 tip). Deliberately NOT
    // part of amountInPaisa and NOT checked against the order's remaining
    // due — a tip is money for staff, not payment toward the bill, so it
    // can't ever cause the overpayment rejection in the payments route.
    // Summed separately (src/lib/payments.ts's computeTipTotal) for
    // receipts/reports. Not reversible via the refunds route in this phase
    // — see PHASE_13_NOTES.md.
    tipInPaisa: integer("tip_in_paisa").notNull().default(0),
    // Links a refund row back to the specific payment it's reversing, for
    // traceability. Optional: a refund can also just be a general credit
    // against the order without pointing at one specific prior payment.
    refundOfPaymentId: uuid("refund_of_payment_id"),
    note: text("note"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payments_restaurant_id_idx").on(table.restaurantId),
    index("payments_order_id_idx").on(table.orderId),
  ],
);

// ---------------------------------------------------------------------------
// Phase 11c — Payment gateway transactions (eSewa / Khalti). See the
// paymentGatewayEnum comment above for how this relates to `payments`.
//
// `gatewayReference` is OUR OWN id for this attempt — the value we generate
// and send to the gateway (eSewa's transaction_uuid / Khalti's
// purchase_order_id) — globally unique (a crypto.randomUUID(), not scoped
// per restaurant) so it can be used as the sole lookup key from the public,
// unauthenticated callback route: that route has no restaurant slug/session
// to scope by, so the lookup is necessarily global — see the QA hardening
// notes for why a per-restaurant unique index here was a latent
// inconsistency even though a UUIDv4 collision is not a realistic risk on
// its own. The callback never trusts restaurantId/orderId/amount from the
// redirect's query string, only from this row, found via a reference
// nothing but our own initiate step could have produced. `gatewayTransactionId` is the
// GATEWAY's own id for the completed transaction (eSewa's transaction_code
// / Khalti's transaction_id), populated only once verified.
// ---------------------------------------------------------------------------

export const paymentGatewayTransactions = pgTable(
  "payment_gateway_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    gateway: paymentGatewayEnum("gateway").notNull(),
    status: paymentGatewayTransactionStatusEnum("status").notNull().default("initiated"),
    amountInPaisa: integer("amount_in_paisa").notNull(),
    gatewayReference: varchar("gateway_reference", { length: 100 }).notNull(),
    gatewayTransactionId: varchar("gateway_transaction_id", { length: 150 }),
    // The verified callback/lookup payload, kept for audit and debugging —
    // never re-parsed for authorization decisions after the fact (status
    // above is the source of truth once set).
    rawResponse: jsonb("raw_response"),
    // Set once a `payments` row is actually inserted (status -> completed).
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("payment_gateway_transactions_restaurant_id_idx").on(table.restaurantId),
    index("payment_gateway_transactions_order_id_idx").on(table.orderId),
    uniqueIndex("payment_gateway_transactions_reference_unique").on(table.gatewayReference),
  ],
);

export const paymentGatewayTransactionsRelations = relations(
  paymentGatewayTransactions,
  ({ one }) => ({
    restaurant: one(restaurants, {
      fields: [paymentGatewayTransactions.restaurantId],
      references: [restaurants.id],
    }),
    order: one(orders, {
      fields: [paymentGatewayTransactions.orderId],
      references: [orders.id],
    }),
    payment: one(payments, {
      fields: [paymentGatewayTransactions.paymentId],
      references: [payments.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Phase 7 — Inventory: suppliers, stock items, purchases (stock-in), a
// stock-movement ledger, and recipes linking a menu item to the ingredients
// (and quantities) one serving consumes.
//
// Quantities are stored as integer MILLIUNITS (a real quantity * 1000, i.e.
// 3 decimal places of precision) rather than floats — the exact same
// "integers only" reasoning as src/lib/money.ts uses for paisa, applied to
// physical quantities instead of currency. See src/lib/quantity.ts for the
// conversion helpers. Each inventory item has exactly ONE unit of measure;
// there is no unit-conversion system in this phase (e.g. you cannot record
// a purchase in grams against an item tracked in kilograms) — see
// PHASE_7_NOTES.md for that tradeoff.
//
// currentStockMilliunits and costPerUnitInPaisa on inventory_items are
// CACHED/DERIVED values, recomputed by src/lib/inventory.ts's
// recordStockMovement()/applyPurchaseCosting() helpers every time a
// purchase, sale-deduction, or manual adjustment is recorded — never
// hand-edited directly. The actual source of truth for "what happened to
// this item's stock" is the stock_movements ledger (same ledger-over-
// mutable-single-field philosophy as the payments table from Phase 5).
// ---------------------------------------------------------------------------

export const inventoryUnitEnum = pgEnum("inventory_unit", [
  "g",
  "kg",
  "ml",
  "l",
  "piece",
  "packet",
  "dozen",
]);

export const stockMovementTypeEnum = pgEnum("stock_movement_type", [
  "purchase",
  "sale_deduction",
  "adjustment",
  // P2 — split out from the generic "adjustment" bucket so wastage/spoilage
  // can be filtered and reported on separately from ordinary count
  // corrections (a stock-count variance and a bag of spoiled onions are
  // very different signals for an owner, even though both used to land as
  // an undifferentiated "adjustment" with only a free-text note to tell
  // them apart). Always a negative quantityDeltaMilliunits — see
  // wasteReasonEnum below and recordStockAdjustmentSchema.
  "waste",
]);

// P2 — a structured reason taxonomy for "waste" movements, alongside the
// existing free-text `note` column (kept for detail — "waste: spoilage,
// note: 'left out overnight'"). Deliberately a fixed, small enum rather
// than open text: it's what makes a wastage report groupable/chartable at
// all ("60% of this month's waste was spoilage" is only answerable if
// reason is structured data, not prose). Nullable — only meaningful when
// stock_movements.type = 'waste'; every other movement type leaves it null.
export const wasteReasonEnum = pgEnum("waste_reason", [
  "spoilage",
  "expired",
  "breakage",
  "overproduction",
  "theft_or_loss",
  "other",
]);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 150 }).notNull(),
    phone: varchar("phone", { length: 20 }),
    address: text("address"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("suppliers_restaurant_id_idx").on(table.restaurantId)],
);

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 150 }).notNull(), // e.g. "Chicken (raw)", "Coke 250ml bottle"
    unit: inventoryUnitEnum("unit").notNull(),
    // Cached — see schema-section comment above. Can go negative (stock
    // wasn't blocked at order time — see PHASE_7_NOTES.md); never
    // hand-edited outside src/lib/inventory.ts.
    currentStockMilliunits: integer("current_stock_milliunits").notNull().default(0),
    // Low-stock threshold in the item's own unit, milliunits. Null = no
    // alerting configured for this item.
    reorderLevelMilliunits: integer("reorder_level_milliunits"),
    // Weighted-average cost per ONE WHOLE UNIT (not per milliunit), in
    // paisa. Updated on every purchase — see applyPurchaseCosting().
    costPerUnitInPaisa: integer("cost_per_unit_in_paisa").notNull().default(0),
    preferredSupplierId: uuid("preferred_supplier_id").references(() => suppliers.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("inventory_items_restaurant_id_idx").on(table.restaurantId),
    index("inventory_items_preferred_supplier_id_idx").on(table.preferredSupplierId),
  ],
);

export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    // P2 — which branch physically received this delivery. Added nullable
    // in drizzle/0030 (backfilled every existing row to the restaurant's
    // main branch, since historical purchases predate branch-scoped
    // inventory and carry no real branch signal), NOT NULL from drizzle/0031
    // onward — every code path writing a purchase supplies one. See
    // BRANCH_INVENTORY.md for the full backfill/scoping writeup.
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    invoiceNumber: varchar("invoice_number", { length: 60 }),
    // Denormalized sum of purchase_items.line_total_in_paisa at creation
    // time — a purchase's line items never change after the fact (no edit
    // endpoint), so this can't drift.
    totalInPaisa: integer("total_in_paisa").notNull(),
    notes: text("notes"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("purchases_restaurant_id_idx").on(table.restaurantId),
    index("purchases_supplier_id_idx").on(table.supplierId),
    index("purchases_branch_id_idx").on(table.branchId),
  ],
);

export const purchaseItems = pgTable(
  "purchase_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseId: uuid("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    inventoryItemId: uuid("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "restrict" }),
    quantityMilliunits: integer("quantity_milliunits").notNull(),
    unitCostInPaisa: integer("unit_cost_in_paisa").notNull(),
    lineTotalInPaisa: integer("line_total_in_paisa").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("purchase_items_purchase_id_idx").on(table.purchaseId)],
);

// ---------------------------------------------------------------------------
// Account Books — Phase 19. A cash-book style debit/credit ledger, kept
// deliberately separate from Reports' revenue-minus-expenses number (see
// reports-helpers.ts's computeNetProfitInPaisa): Reports answers "how much
// did we sell" from order totals; this ledger answers "how much cash
// actually moved" plus "who still owes whom" — the two numbers are allowed
// to disagree (an order can be "completed" with money still outstanding).
//
// "credit" = money in (a sale, a due collected, capital brought in);
// "debit" = money out (an expense, a purchase, a due paid off, a
// withdrawal) — the small-business cash-book sense of the words, not
// formal double-entry T-account debit/credit, which would require a full
// chart of accounts this app doesn't have. Documented here once since
// every call site (ledger.ts) relies on this exact mapping.
// ---------------------------------------------------------------------------

export const ledgerDirectionEnum = pgEnum("ledger_direction", ["credit", "debit"]);

export const ledgerCategoryEnum = pgEnum("ledger_category", [
  "sales",
  "expense",
  "purchase",
  "due_settlement",
  "capital",
  "withdrawal",
  "payroll",
  "other",
]);

// "none" = a normal realized cash entry. "outstanding" = recorded on
// credit — no cash moved yet (a customer's unpaid balance, a supplier bill
// not yet paid, or any manual entry marked "on credit"). "settled" = was
// outstanding, has since been fully collected/paid off via one or more
// linked due_settlement entries (see settleLedgerDue in ledger.ts).
export const ledgerDueStatusEnum = pgEnum("ledger_due_status", ["none", "outstanding", "settled"]);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    // YYYY-MM-DD — the book date this entry is filed under (may differ
    // from createdAt for a backdated manual entry), matching expenses'
    // expenseDate column/pattern. Day/month/year book views group on this.
    entryDate: date("entry_date").notNull().defaultNow(),
    direction: ledgerDirectionEnum("direction").notNull(),
    category: ledgerCategoryEnum("category").notNull(),
    // Always positive — direction carries the sign, same pattern as
    // stock_movements avoided (there it's a signed delta instead) but
    // matches expenses.amountInPaisa's always-positive convention, which
    // this table's category mix (expense/purchase alongside sales) is
    // closer to.
    amountInPaisa: integer("amount_in_paisa").notNull(),
    // Who the money is with — a customer, a supplier, "cash box", a staff
    // member for a reimbursement, etc. Free text (not a customers/
    // suppliers FK) since a ledger entry's counterparty is often someone
    // with no CRM/supplier record at all (a one-off cash sale, a landlord).
    counterpartyName: varchar("counterparty_name", { length: 200 }),
    description: varchar("description", { length: 300 }).notNull(),
    note: text("note"),
    // Traceability for auto-generated entries (referenceType "order" |
    // "expense" | "purchase" | "due_settlement"); null for a manual entry.
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: uuid("reference_id"),
    dueStatus: ledgerDueStatusEnum("due_status").notNull().default("none"),
    // Running total of what's been collected/paid against an outstanding
    // entry via settleLedgerDue — supports partial settlement (a customer
    // paying off part of their tab today, the rest next week) without
    // mutating amountInPaisa, which stays the original full amount for as
    // long as the entry exists.
    settledAmountInPaisa: integer("settled_amount_in_paisa").notNull().default(0),
    isVoided: boolean("is_voided").notNull().default(false),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ledger_entries_restaurant_id_idx").on(table.restaurantId),
    index("ledger_entries_entry_date_idx").on(table.entryDate),
    index("ledger_entries_due_status_idx").on(table.dueStatus),
  ],
);

// ---------------------------------------------------------------------------
// Website Builder — Phase 20. A free, public-facing restaurant website: one
// row per restaurant (1:1, created lazily on first dashboard visit — see
// getOrCreateWebsiteConfig in website.ts), a no-code editor's worth of
// content fields, and an isPublished flag gating whether /site/[slug] is
// reachable at all. Deliberately NOT a generic drag-and-drop page builder
// (no arbitrary block ordering, no custom HTML/CSS) — a fixed set of
// sections (hero, about, gallery, menu highlights, contact/hours, social
// links) covers what a small restaurant actually needs, same
// don't-overbuild judgment call as Account Books' due-tracking design.
//
// The gallery/featured-item/social-link fields are plain nullable jsonb
// (not notNull().default(...)) matching this schema's one existing jsonb
// precedent (openingHours above) — application code (website.ts) treats a
// null column as "empty" rather than relying on a DB-level default.
// ---------------------------------------------------------------------------

export const websiteThemeEnum = pgEnum("website_theme", ["classic", "modern", "warm", "midnight"]);

export type WebsiteSocialLinks = {
  facebook?: string;
  instagram?: string;
  tiktok?: string;
  whatsapp?: string;
  website?: string;
};

export const restaurantWebsites = pgTable(
  "restaurant_websites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    isPublished: boolean("is_published").notNull().default(false),
    theme: websiteThemeEnum("theme").notNull().default("classic"),
    tagline: varchar("tagline", { length: 200 }),
    aboutText: text("about_text"),
    heroImageUrl: text("hero_image_url"),
    // Data: URLs or http(s) URLs, same shape as menuItems.imageUrl — see
    // imageUrlSchema. Capped at MAX_GALLERY_IMAGES (website.ts) at the
    // validation layer, not here.
    galleryImageUrls: jsonb("gallery_image_urls").$type<string[]>(),
    showMenuSection: boolean("show_menu_section").notNull().default(true),
    // Empty/null = auto-pick (first N available items across active
    // categories, see website.ts); non-empty = an owner-curated highlight
    // list, in display order.
    featuredMenuItemIds: jsonb("featured_menu_item_ids").$type<string[]>(),
    socialLinks: jsonb("social_links").$type<WebsiteSocialLinks>(),
    // Null falls back to the restaurant's own phone/address at render time
    // (see website.ts's resolveWebsiteContent) — most restaurants won't
    // bother overriding these.
    contactPhone: varchar("contact_phone", { length: 20 }),
    contactAddress: text("contact_address"),
    seoTitle: varchar("seo_title", { length: 200 }),
    seoDescription: varchar("seo_description", { length: 300 }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("restaurant_websites_restaurant_id_unique").on(table.restaurantId)],
);

export const restaurantWebsitesRelations = relations(restaurantWebsites, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [restaurantWebsites.restaurantId],
    references: [restaurants.id],
  }),
}));

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    inventoryItemId: uuid("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    // P2 — which branch this movement physically happened at. Added
    // nullable in drizzle/0030 (see purchases.branchId's comment above for
    // the exact same backfill story: sale_deduction rows backfill from the
    // referenced order's branchId, purchase rows from the referenced
    // purchase's branchId, everything else — manual adjustments predating
    // this column — falls back to the restaurant's main branch), NOT NULL
    // from drizzle/0031 onward. recordStockMovement() requires this on
    // every write going forward; see its own doc comment.
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    type: stockMovementTypeEnum("type").notNull(),
    // Positive for purchase/stock-in and positive manual adjustments,
    // negative for sale deductions, waste, and negative manual adjustments
    // (count corrections) — same signed-ledger pattern as
    // payments.amountInPaisa.
    quantityDeltaMilliunits: integer("quantity_delta_milliunits").notNull(),
    // P2 — see wasteReasonEnum's own comment. Set only when type='waste';
    // enforced at the application layer (recordStockMovement), not a DB
    // CHECK constraint — this schema doesn't use CHECK constraints
    // elsewhere for cross-column rules, matching the existing convention.
    wasteReason: wasteReasonEnum("waste_reason"),
    // Informational traceability to what caused this movement (a purchase
    // id, an order id) — same pattern as menu_item_id on order_items:
    // never read back for correctness, only for "why did this change".
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: uuid("reference_id"),
    note: text("note"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stock_movements_restaurant_id_idx").on(table.restaurantId),
    index("stock_movements_inventory_item_id_idx").on(table.inventoryItemId),
    index("stock_movements_branch_id_idx").on(table.branchId),
  ],
);

// ---------------------------------------------------------------------------
// P2 — branch-scoped stock levels. inventoryItems.currentStockMilliunits
// (above) stays the authoritative RESTAURANT-WIDE total — every existing
// caller (low-stock alerts, weighted-average costing, the Items tab) keeps
// reading/writing it exactly as before, unchanged. This table is additive:
// one row per (branch, item), incremented atomically in lockstep with the
// restaurant-wide total inside the same recordStockMovement() transaction
// (see src/lib/inventory.ts), so the per-branch figures can never drift out
// of sync with the restaurant-wide one they sum to. Powers per-branch stock
// views, branch-to-branch transfers, and branch-scoped physical stock
// counts — see BRANCH_INVENTORY.md.
//
// A row only exists once a movement has actually happened at that branch
// (no zero-rows pre-created for every branch x item pair) — read code
// treats a missing row as zero stock, same convention as "no recipe" being
// treated as zero ingredients rather than an error.
// ---------------------------------------------------------------------------

export const branchInventoryLevels = pgTable(
  "branch_inventory_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    inventoryItemId: uuid("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    currentStockMilliunits: integer("current_stock_milliunits").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("branch_inventory_levels_branch_item_unique").on(
      table.branchId,
      table.inventoryItemId,
    ),
    index("branch_inventory_levels_inventory_item_id_idx").on(table.inventoryItemId),
  ],
);

export const recipeItems = pgTable(
  "recipe_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    inventoryItemId: uuid("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "restrict" }),
    // How much of this ingredient ONE serving of the menu item consumes, in
    // the ingredient's own unit, milliunits.
    quantityPerServingMilliunits: integer("quantity_per_serving_milliunits").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("recipe_items_restaurant_id_idx").on(table.restaurantId),
    index("recipe_items_menu_item_id_idx").on(table.menuItemId),
    uniqueIndex("recipe_items_menu_item_ingredient_unique").on(
      table.menuItemId,
      table.inventoryItemId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Phase 8 — Customers (CRM) + loyalty. A customer is keyed by phone number
// per restaurant (not globally — the same phone can be a customer at two
// different unrelated restaurants, unlike `users.phone` which is a login
// identity). loyaltyPointsBalance/lifetimePointsEarned/totalOrdersCount/
// totalSpentInPaisa are all CACHED/DERIVED values recomputed by
// src/lib/loyalty.ts, never hand-edited — the loyalty_transactions ledger
// is the actual source of truth for points, same philosophy as
// payments/stock_movements. lifetimePointsEarned (not the current,
// spendable balance) drives loyalty tier — redeeming points shouldn't
// demote a customer's tier, only earning more or less does.
// ---------------------------------------------------------------------------

export const loyaltyTransactionTypeEnum = pgEnum("loyalty_transaction_type", [
  "earn",
  "redeem",
  "adjustment",
]);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    phone: varchar("phone", { length: 20 }).notNull(),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    email: varchar("email", { length: 255 }),
    notes: text("notes"),
    loyaltyPointsBalance: integer("loyalty_points_balance").notNull().default(0),
    lifetimePointsEarned: integer("lifetime_points_earned").notNull().default(0),
    totalOrdersCount: integer("total_orders_count").notNull().default(0),
    totalSpentInPaisa: integer("total_spent_in_paisa").notNull().default(0),
    // Phase 18 — visit streaks + birthday bonus. dateOfBirth is optional
    // (a customer may never share it); only its month+day are ever read
    // (see loyalty-birthday.ts), the year is kept for display only.
    // lastVisitDate/currentVisitStreak/longestVisitStreak are maintained by
    // recordOrderCompletionLoyalty (loyalty.ts) — one calendar day with a
    // completed order counts as one "visit" regardless of order count that
    // day. lastBirthdayBonusYear guards the once-per-year bonus (see
    // awardBirthdayBonus) against double-award, both from two completed
    // orders the same birthday and from the "self-healing on read" checks
    // in the customers GET routes.
    dateOfBirth: date("date_of_birth"),
    currentVisitStreak: integer("current_visit_streak").notNull().default(0),
    longestVisitStreak: integer("longest_visit_streak").notNull().default(0),
    lastVisitDate: date("last_visit_date"),
    lastBirthdayBonusYear: integer("last_birthday_bonus_year"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("customers_restaurant_id_idx").on(table.restaurantId),
    uniqueIndex("customers_restaurant_phone_unique").on(table.restaurantId, table.phone),
  ],
);

export const loyaltyTransactions = pgTable(
  "loyalty_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    type: loyaltyTransactionTypeEnum("type").notNull(),
    // Positive for earn/positive adjustments, negative for redeem/negative
    // adjustments — same signed-ledger pattern as payments.amountInPaisa
    // and stock_movements.quantityDeltaMilliunits.
    pointsDelta: integer("points_delta").notNull(),
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: uuid("reference_id"),
    note: text("note"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("loyalty_transactions_restaurant_id_idx").on(table.restaurantId),
    index("loyalty_transactions_customer_id_idx").on(table.customerId),
  ],
);

// ---------------------------------------------------------------------------
// Phase 8 — Staff attendance. Staff management itself (adding a staff
// member, changing their role, deactivating them) reuses the existing
// users/user_roles tables from Phase 1 — a "staff member" IS a user with a
// user_roles grant on this restaurant, there's no separate staff table.
// Attendance is the one genuinely new concept: a clock-in/clock-out ledger
// per user per restaurant, deliberately NOT a single mutable "currently
// clocked in?" flag on the user — same "ledger over mutable single field"
// reasoning as payments/stock_movements. A record with a null clockOutAt
// is an open shift; at most one open shift per user per restaurant is
// enforced in src/lib/attendance.ts, not at the DB constraint level (an
// exclusion constraint would be more airtight but is deferred — see
// PHASE_8_NOTES.md).
// ---------------------------------------------------------------------------

export const attendanceRecords = pgTable(
  "attendance_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Phase 11a — nullable because every pre-multi-branch shift has no
    // branch on record, and because a restaurant may simply not care to
    // scope attendance by branch. Stamped from the clocking-in user's own
    // branch-scoped grant when they have one; left null for an
    // unrestricted (all-branches) staff member.
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    clockInAt: timestamp("clock_in_at", { withTimezone: true }).notNull().defaultNow(),
    clockOutAt: timestamp("clock_out_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("attendance_records_restaurant_id_idx").on(table.restaurantId),
    index("attendance_records_user_id_idx").on(table.userId),
    index("attendance_records_branch_id_idx").on(table.branchId),
    // DB-level backstop for "at most one open shift per user" — the
    // clock-in route's own SELECT-then-INSERT check (see its doc comment)
    // is a plain read-then-write with no locking, so two clock-in requests
    // for the same user arriving close enough together (a double-tap, or a
    // flaky-connection retry) could both pass the SELECT before either
    // INSERT committed, opening two simultaneous shifts. Partial (WHERE
    // clock_out_at IS NULL) so closed shift history accumulates freely —
    // only a concurrently-OPEN shift per (user, restaurant) is constrained.
    // Same pattern as service_calls_one_active_per_table_unique /
    // user_roles_one_active_per_restaurant_unique above.
    uniqueIndex("attendance_records_one_open_shift_per_user_unique")
      .on(table.userId, table.restaurantId)
      .where(sql`${table.clockOutAt} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Expenses (Phase 8c, workflow added Phase 21) — operational spending
// tracking: rent, utilities, salaries paid in cash, supply runs, and the
// like. isVoided remains the soft-delete flag (an expense may need
// correcting or voiding after the fact) — but voiding now creates a
// reversal ledger entry (see reverseExpenseLedgerEntry in ledger.ts)
// instead of silently leaving the original debit sitting in Account
// Books, so a voided expense's financial trail stays intact rather than
// just going stale.
//
// Phase 21 replaced the old fixed 8-value `expense_category` enum (see
// git history / PHASE_8c_NOTES.md) with a real per-restaurant table —
// custom categories were an explicitly documented "known gap" from
// Phase 8c, and a Postgres enum can't grow per-tenant at runtime the way
// a table can. Existing rows were backfilled onto the closest-matching
// new default category (see the migration).
// ---------------------------------------------------------------------------

export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("expense_categories_restaurant_id_idx").on(table.restaurantId),
    uniqueIndex("expense_categories_restaurant_name_idx").on(table.restaurantId, table.name),
  ],
);

// How an expense was actually settled once PAID. Deliberately a distinct,
// smaller enum from PAYMENT_METHODS (payments.ts, used for incoming
// order payments: cash/card/mobile_wallet/other) — an outgoing business
// payment splits "mobile wallet" into esewa/khalti explicitly (so
// payment-method breakdown reporting can tell them apart, per the
// financial dashboard spec) and adds bank_transfer/mobile_banking, which
// have no meaning for a customer paying at the till.
export const expensePaymentMethodEnum = pgEnum("expense_payment_method", [
  "cash",
  "bank_transfer",
  "esewa",
  "khalti",
  "mobile_banking",
  "other",
]);

// pending_approval -> approved -> paid is the multi-step flow for a
// creator who doesn't hold pay/approve authority themselves (see
// resolveInitialExpenseStatus in expense-workflow.ts). rejected is a
// terminal dead end from pending_approval. A creator who already holds
// APPROVE_EXPENSE or PAY_EXPENSE skips straight to "approved" or "paid"
// respectively — this is what keeps today's one-step owner/manager flow
// working unchanged rather than forcing everyone through every stage.
export const expenseStatusEnum = pgEnum("expense_status", [
  "pending_approval",
  "approved",
  "rejected",
  "paid",
]);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    // Nullable — an expense isn't required to be pinned to one branch
    // (e.g. a platform-wide software subscription). Set, it scopes the
    // expense to that branch for branch-filtered reporting.
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => expenseCategories.id, { onDelete: "restrict" }),
    amountInPaisa: integer("amount_in_paisa").notNull(),
    description: varchar("description", { length: 300 }).notNull(),
    // The calendar date the expense actually happened — separate from
    // createdAt, since an expense is often logged after the fact (e.g.
    // entering yesterday's electricity bill today). Defaults to today.
    expenseDate: date("expense_date").notNull().defaultNow(),
    note: text("note"),
    status: expenseStatusEnum("status").notNull().default("paid"),
    // Only ever set once status = "paid" — see recordExpenseLedgerEntry's
    // call site, which is the ONLY place this table's ledger debit gets
    // created (matches the spec's "never mark paid before confirmation").
    paymentMethod: expensePaymentMethodEnum("payment_method"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidByUserId: uuid("paid_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    rejectionReason: varchar("rejection_reason", { length: 300 }),
    isVoided: boolean("is_voided").notNull().default(false),
    // Who originally submitted/created this expense (a request, or a
    // direct paid entry) — "created by" throughout the audit trail.
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("expenses_restaurant_id_idx").on(table.restaurantId),
    index("expenses_expense_date_idx").on(table.expenseDate),
    index("expenses_branch_id_idx").on(table.branchId),
    index("expenses_category_id_idx").on(table.categoryId),
    index("expenses_status_idx").on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Payroll (Phase 22) — salary info captured per staff member and the
// payout history when an owner/accountant actually pays it. Deliberately
// two tables rather than one: staffSalaryConfigs is the standing "what do
// we pay this person" record (edited rarely, once per raise), while
// payrollPayments is an append-only receipt per actual payout (one row per
// pay run) — same "config vs. event log" split used elsewhere (e.g.
// restaurants.openingHours vs. attendanceRecords).
//
// Every payout also books a debit into the SAME Account Books ledger
// expenses/purchases already use (see recordPayrollLedgerEntry in
// ledger.ts) rather than a separate money trail — but with the staff
// member's name deliberately left OUT of that shared ledger entry.
// MANAGE_ACCOUNT_BOOKS is held by `manager`, who is explicitly NOT granted
// VIEW_PAYROLL/MANAGE_PAYROLL (see permissions.ts's "salary information
// must stay private" comment) — a named "Salary: John Doe — Rs 45,000"
// line in the shared ledger would leak exactly what that boundary exists
// to prevent. The ledger entry stays honest about aggregate cash movement
// (so Account Books still reconciles) while only the payroll module itself
// (VIEW_PAYROLL/MANAGE_PAYROLL-gated) ever shows who was paid what.
// ---------------------------------------------------------------------------

export const salaryTypeEnum = pgEnum("salary_type", ["monthly", "daily", "hourly"]);

// 1:1 with a userRoles grant (a person's staff membership at THIS
// restaurant) rather than with the user directly — the same person could
// hold different salary terms at two different restaurants if RestroMitra
// ever supports one account working multiple places, matching how `role`
// itself is already per-userRoles-grant, not per-user.
export const staffSalaryConfigs = pgTable(
  "staff_salary_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userRoleId: uuid("user_role_id")
      .notNull()
      .references(() => userRoles.id, { onDelete: "cascade" }),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    salaryType: salaryTypeEnum("salary_type").notNull().default("monthly"),
    amountInPaisa: integer("amount_in_paisa").notNull(),
    // The method this person is USUALLY paid by — pre-fills the "Pay"
    // form's method selector each pay run, but every individual payout can
    // still choose a different one (see payrollPayments.paymentMethod)
    // without editing this standing config. Reuses the exact same
    // cash/bank_transfer/esewa/khalti/mobile_banking/other set as outgoing
    // expense payments (see payout-methods.ts) — same "no payout API,
    // every method is a manual human confirmation" reality applies here.
    paymentMethod: expensePaymentMethodEnum("payment_method"),
    bankName: varchar("bank_name", { length: 150 }),
    bankAccountNumber: varchar("bank_account_number", { length: 50 }),
    bankAccountHolder: varchar("bank_account_holder", { length: 200 }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("staff_salary_configs_user_role_id_idx").on(table.userRoleId),
    index("staff_salary_configs_restaurant_id_idx").on(table.restaurantId),
  ],
);

export const payrollPayments = pgTable(
  "payroll_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    // "restrict", not "cascade" — a payout receipt must survive even if
    // the staff member is later deactivated (userRoles rows are soft-
    // deleted via isActive, never hard-deleted in normal operation, so
    // this should never actually block anything in practice).
    userRoleId: uuid("user_role_id")
      .notNull()
      .references(() => userRoles.id, { onDelete: "restrict" }),
    // Snapshot, same reasoning as orderItems.menuItemNameSnapshot — this
    // receipt should keep reading correctly even if the person's account
    // name is edited (or the userRoles row is one day hard-deleted) after
    // the fact.
    staffNameSnapshot: varchar("staff_name_snapshot", { length: 200 }).notNull(),
    amountInPaisa: integer("amount_in_paisa").notNull(),
    // Free-text label ("August 2026", "Aug 1-15 advance") shown on the
    // receipt — kept separate from the optional structured
    // periodStart/periodEnd so an ad-hoc payment (a bonus, an advance) that
    // doesn't map to a clean date range can still be paid and labeled.
    payPeriodLabel: varchar("pay_period_label", { length: 100 }),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    paymentMethod: expensePaymentMethodEnum("payment_method").notNull(),
    note: text("note"),
    // Same "reverse via a new ledger entry, never mutate/delete the
    // original" pattern as expenses.isVoided — see reversePayrollLedgerEntry
    // in ledger.ts.
    isVoided: boolean("is_voided").notNull().default(false),
    paidByUserId: uuid("paid_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    paidAt: timestamp("paid_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payroll_payments_restaurant_id_idx").on(table.restaurantId),
    index("payroll_payments_user_role_id_idx").on(table.userRoleId),
    index("payroll_payments_paid_at_idx").on(table.paidAt),
  ],
);

// ---------------------------------------------------------------------------
// Reservations (Phase 8d) — table bookings taken ahead of time (phone/
// walk-in request), separate from the QR/POS order flow. A reservation
// does NOT create an order; "seated" just marks that the party has
// arrived, staff still create the actual order themselves once seated
// (see PHASE_8d_NOTES.md's "Known gaps" for why auto-creating one is
// deferred). Status moves through a one-directional state machine (see
// src/lib/reservation-status.ts), same "state machine, not a mutable
// free-text status" pattern as orders.
// ---------------------------------------------------------------------------

export const reservationStatusEnum = pgEnum("reservation_status", [
  "requested",
  "confirmed",
  "seated",
  "completed",
  "cancelled",
  "no_show",
]);

export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    // Optional CRM link (Phase 8b) — a reservation can be tied to a known
    // customer record, or just a name+phone for someone not in the CRM
    // yet. customerName/customerPhone are always captured directly (not
    // derived from the customer row) so a reservation stays fully
    // readable even if the linked customer is later deactivated.
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: varchar("customer_name", { length: 150 }).notNull(),
    customerPhone: varchar("customer_phone", { length: 20 }).notNull(),
    partySize: integer("party_size").notNull(),
    // Assigned when staff confirm the booking against a specific table;
    // nullable because a reservation can be requested/confirmed before a
    // table is picked (e.g. taken over the phone before the floor plan
    // for that night is finalized).
    tableId: uuid("table_id").references(() => restaurantTables.id, { onDelete: "set null" }),
    // Phase 11a — an explicit column rather than only deriving branch via
    // tableId, precisely because tableId is nullable (a reservation taken
    // over the phone before a table is assigned still needs to know which
    // branch it's for). Derived from tableId's own branch when a table is
    // picked; otherwise supplied directly (and access-checked) at create
    // time. Nullable for the same "pre-multi-branch data has none" reason
    // as attendance_records.branchId above.
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    reservationTime: timestamp("reservation_time", { withTimezone: true }).notNull(),
    // Estimated dining duration — used for a soft double-booking warning
    // in the UI, not a hard DB constraint (see known gaps).
    durationMinutes: integer("duration_minutes").notNull().default(90),
    status: reservationStatusEnum("status").notNull().default("requested"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("reservations_restaurant_id_idx").on(table.restaurantId),
    index("reservations_reservation_time_idx").on(table.reservationTime),
    index("reservations_table_id_idx").on(table.tableId),
    index("reservations_branch_id_idx").on(table.branchId),
  ],
);

// ---------------------------------------------------------------------------
// Phase 10 — SaaS plans, trials, subscriptions, platform admin
// ---------------------------------------------------------------------------

/**
 * The append-only history of every subscription state change for a
 * restaurant: trial start/extension/expiry, an owner's upgrade request,
 * and every platform-admin action (assigning/changing a plan, activating,
 * marking past-due, cancelling, reactivating). `restaurants.subscription
 * Status`/`planKey` are the fast-to-read current snapshot; this table is
 * the "how did we get here" timeline shown on both the owner's /billing
 * page and a platform admin's restaurant detail view.
 *
 * `performedByUserId` is null for system-generated events (trial_expired,
 * fired the moment a request notices trialEndsAt has passed — see
 * src/lib/subscription-db.ts) and set for anything a human did (an
 * owner's upgrade request, or any platform-admin action).
 */
export const subscriptionEvents = pgTable(
  "subscription_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    eventType: subscriptionEventTypeEnum("event_type").notNull(),
    fromStatus: subscriptionStatusEnum("from_status"),
    toStatus: subscriptionStatusEnum("to_status"),
    planKey: planKeyEnum("plan_key"),
    note: text("note"),
    performedByUserId: uuid("performed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("subscription_events_restaurant_id_idx").on(table.restaurantId),
    index("subscription_events_created_at_idx").on(table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Audit log (referenced from Phase 1 onward — auth events start immediately)
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").references(() => restaurants.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 100 }).notNull(), // e.g. "auth.login"
    resourceType: varchar("resource_type", { length: 100 }),
    resourceId: varchar("resource_id", { length: 100 }),
    ipAddress: varchar("ip_address", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_logs_restaurant_id_idx").on(table.restaurantId),
    index("audit_logs_user_id_idx").on(table.userId),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Relations (for query ergonomics)
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  roles: many(userRoles),
}));

export const restaurantsRelations = relations(restaurants, ({ many }) => ({
  branches: many(branches),
  userRoles: many(userRoles),
  subscriptionEvents: many(subscriptionEvents),
}));

export const subscriptionEventsRelations = relations(subscriptionEvents, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [subscriptionEvents.restaurantId],
    references: [restaurants.id],
  }),
  performedBy: one(users, {
    fields: [subscriptionEvents.performedByUserId],
    references: [users.id],
  }),
}));

export const branchesRelations = relations(branches, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [branches.restaurantId],
    references: [restaurants.id],
  }),
}));

export const userRolesRelations = relations(userRoles, ({ one, many }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  restaurant: one(restaurants, {
    fields: [userRoles.restaurantId],
    references: [restaurants.id],
  }),
  branch: one(branches, {
    fields: [userRoles.branchId],
    references: [branches.id],
  }),
  salaryConfig: one(staffSalaryConfigs, {
    fields: [userRoles.id],
    references: [staffSalaryConfigs.userRoleId],
  }),
  payrollPayments: many(payrollPayments),
}));

export const attendanceRecordsRelations = relations(attendanceRecords, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [attendanceRecords.restaurantId],
    references: [restaurants.id],
  }),
  user: one(users, { fields: [attendanceRecords.userId], references: [users.id] }),
  branch: one(branches, {
    fields: [attendanceRecords.branchId],
    references: [branches.id],
  }),
}));

export const expensesRelations = relations(expenses, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [expenses.restaurantId],
    references: [restaurants.id],
  }),
  branch: one(branches, {
    fields: [expenses.branchId],
    references: [branches.id],
  }),
  category: one(expenseCategories, {
    fields: [expenses.categoryId],
    references: [expenseCategories.id],
  }),
  recordedBy: one(users, {
    fields: [expenses.recordedByUserId],
    references: [users.id],
    relationName: "expenseRecordedBy",
  }),
  approvedBy: one(users, {
    fields: [expenses.approvedByUserId],
    references: [users.id],
    relationName: "expenseApprovedBy",
  }),
  paidBy: one(users, {
    fields: [expenses.paidByUserId],
    references: [users.id],
    relationName: "expensePaidBy",
  }),
}));

export const expenseCategoriesRelations = relations(expenseCategories, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [expenseCategories.restaurantId],
    references: [restaurants.id],
  }),
  expenses: many(expenses),
}));

export const staffSalaryConfigsRelations = relations(staffSalaryConfigs, ({ one }) => ({
  userRole: one(userRoles, {
    fields: [staffSalaryConfigs.userRoleId],
    references: [userRoles.id],
  }),
  restaurant: one(restaurants, {
    fields: [staffSalaryConfigs.restaurantId],
    references: [restaurants.id],
  }),
}));

export const payrollPaymentsRelations = relations(payrollPayments, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [payrollPayments.restaurantId],
    references: [restaurants.id],
  }),
  userRole: one(userRoles, {
    fields: [payrollPayments.userRoleId],
    references: [userRoles.id],
  }),
  paidBy: one(users, {
    fields: [payrollPayments.paidByUserId],
    references: [users.id],
  }),
}));

export const reservationsRelations = relations(reservations, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [reservations.restaurantId],
    references: [restaurants.id],
  }),
  customer: one(customers, {
    fields: [reservations.customerId],
    references: [customers.id],
  }),
  table: one(restaurantTables, {
    fields: [reservations.tableId],
    references: [restaurantTables.id],
  }),
  branch: one(branches, {
    fields: [reservations.branchId],
    references: [branches.id],
  }),
  createdBy: one(users, {
    fields: [reservations.createdByUserId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const kitchenStationsRelations = relations(kitchenStations, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [kitchenStations.restaurantId],
    references: [restaurants.id],
  }),
  menuItems: many(menuItems),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [categories.restaurantId],
    references: [restaurants.id],
  }),
  menuItems: many(menuItems),
}));

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [menuItems.restaurantId],
    references: [restaurants.id],
  }),
  category: one(categories, {
    fields: [menuItems.categoryId],
    references: [categories.id],
  }),
  kitchenStation: one(kitchenStations, {
    fields: [menuItems.kitchenStationId],
    references: [kitchenStations.id],
  }),
  variants: many(menuVariants),
  addons: many(menuAddons),
  recipeItems: many(recipeItems),
}));

export const menuVariantsRelations = relations(menuVariants, ({ one }) => ({
  menuItem: one(menuItems, {
    fields: [menuVariants.menuItemId],
    references: [menuItems.id],
  }),
}));

export const menuAddonsRelations = relations(menuAddons, ({ one }) => ({
  menuItem: one(menuItems, {
    fields: [menuAddons.menuItemId],
    references: [menuItems.id],
  }),
}));

export const restaurantTablesRelations = relations(restaurantTables, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [restaurantTables.restaurantId],
    references: [restaurants.id],
  }),
  branch: one(branches, {
    fields: [restaurantTables.branchId],
    references: [branches.id],
  }),
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [orders.restaurantId],
    references: [restaurants.id],
  }),
  branch: one(branches, {
    fields: [orders.branchId],
    references: [branches.id],
  }),
  table: one(restaurantTables, {
    fields: [orders.tableId],
    references: [restaurantTables.id],
  }),
  customer: one(customers, {
    fields: [orders.customerId],
    references: [customers.id],
  }),
  items: many(orderItems),
  payments: many(payments),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [customers.restaurantId],
    references: [restaurants.id],
  }),
  orders: many(orders),
  loyaltyTransactions: many(loyaltyTransactions),
}));

export const loyaltyTransactionsRelations = relations(loyaltyTransactions, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [loyaltyTransactions.restaurantId],
    references: [restaurants.id],
  }),
  customer: one(customers, {
    fields: [loyaltyTransactions.customerId],
    references: [customers.id],
  }),
  recordedBy: one(users, {
    fields: [loyaltyTransactions.recordedByUserId],
    references: [users.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [payments.restaurantId],
    references: [restaurants.id],
  }),
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
  recordedBy: one(users, {
    fields: [payments.recordedByUserId],
    references: [users.id],
  }),
}));

export const orderItemsRelations = relations(orderItems, ({ one, many }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  menuItem: one(menuItems, {
    fields: [orderItems.menuItemId],
    references: [menuItems.id],
  }),
  variant: one(menuVariants, {
    fields: [orderItems.variantId],
    references: [menuVariants.id],
  }),
  kitchenStation: one(kitchenStations, {
    fields: [orderItems.kitchenStationId],
    references: [kitchenStations.id],
  }),
  addons: many(orderItemAddons),
}));

export const orderItemAddonsRelations = relations(orderItemAddons, ({ one }) => ({
  orderItem: one(orderItems, {
    fields: [orderItemAddons.orderItemId],
    references: [orderItems.id],
  }),
  addon: one(menuAddons, {
    fields: [orderItemAddons.addonId],
    references: [menuAddons.id],
  }),
}));

export const suppliersRelations = relations(suppliers, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [suppliers.restaurantId],
    references: [restaurants.id],
  }),
  inventoryItems: many(inventoryItems),
  purchases: many(purchases),
}));

export const inventoryItemsRelations = relations(inventoryItems, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [inventoryItems.restaurantId],
    references: [restaurants.id],
  }),
  preferredSupplier: one(suppliers, {
    fields: [inventoryItems.preferredSupplierId],
    references: [suppliers.id],
  }),
  purchaseItems: many(purchaseItems),
  stockMovements: many(stockMovements),
  recipeItems: many(recipeItems),
  branchLevels: many(branchInventoryLevels),
}));

export const branchInventoryLevelsRelations = relations(branchInventoryLevels, ({ one }) => ({
  branch: one(branches, {
    fields: [branchInventoryLevels.branchId],
    references: [branches.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [branchInventoryLevels.inventoryItemId],
    references: [inventoryItems.id],
  }),
}));

export const purchasesRelations = relations(purchases, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [purchases.restaurantId],
    references: [restaurants.id],
  }),
  branch: one(branches, {
    fields: [purchases.branchId],
    references: [branches.id],
  }),
  supplier: one(suppliers, {
    fields: [purchases.supplierId],
    references: [suppliers.id],
  }),
  recordedBy: one(users, {
    fields: [purchases.recordedByUserId],
    references: [users.id],
  }),
  items: many(purchaseItems),
}));

export const purchaseItemsRelations = relations(purchaseItems, ({ one }) => ({
  purchase: one(purchases, {
    fields: [purchaseItems.purchaseId],
    references: [purchases.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [purchaseItems.inventoryItemId],
    references: [inventoryItems.id],
  }),
}));

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [stockMovements.restaurantId],
    references: [restaurants.id],
  }),
  branch: one(branches, {
    fields: [stockMovements.branchId],
    references: [branches.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [stockMovements.inventoryItemId],
    references: [inventoryItems.id],
  }),
  recordedBy: one(users, {
    fields: [stockMovements.recordedByUserId],
    references: [users.id],
  }),
}));

export const recipeItemsRelations = relations(recipeItems, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [recipeItems.restaurantId],
    references: [restaurants.id],
  }),
  menuItem: one(menuItems, {
    fields: [recipeItems.menuItemId],
    references: [menuItems.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [recipeItems.inventoryItemId],
    references: [inventoryItems.id],
  }),
}));

// ---------------------------------------------------------------------------
// Real-time: service calls ("Call staff") + the generic event log behind SSE
// ---------------------------------------------------------------------------
//
// Deployment reality check (this drove the design below): this app ships as
// serverless functions (see netlify.toml's @netlify/plugin-nextjs / Vercel),
// not one long-running Node process — the same reason rate-limit.ts's
// in-memory bucket map is documented as unsafe across instances. A naive
// in-memory EventEmitter pub/sub for SSE would have the identical problem:
// an event published from the invocation that handled the write would never
// reach an SSE connection being held open on a different instance. So the
// broadcast mechanism here is the database itself, not memory: every
// real-time-worthy write also inserts one row into `realtime_events`, and
// every SSE connection is a request handler that repeatedly polls that
// table (short interval, e.g. 1s) and forwards new rows to the client as
// they appear — see src/lib/realtime.ts. This is genuinely pushed to the
// browser (the client never issues a request to learn about a new event,
// the open connection delivers it), it's just backed by DB polling instead
// of a live pub/sub channel, which is the honest, reliable option that
// actually works on this hosting model. `id` is a bigserial specifically so
// "everything after cursor X" is a cheap, safe indexed range scan.

export const realtimeEvents = pgTable(
  "realtime_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    // Null = restaurant-wide (every connected staff member should see it,
    // regardless of which branch they're scoped to). Set for events tied to
    // one branch's floor (an order, a service call) so a branch-scoped
    // staff member's stream never has to fan out restaurant-wide.
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 60 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("realtime_events_restaurant_id_id_idx").on(table.restaurantId, table.id),
  ],
);

export const serviceCallStatusEnum = pgEnum("service_call_status", [
  "pending",
  "acknowledged",
  "resolved",
]);

// The "Call Servicemen" button on the public QR menu creates one of these.
// Deliberately table-scoped, not order-scoped — a guest can call staff
// before ordering, between courses, or just to ask for water, none of which
// need to reference a specific order.
export const serviceCalls = pgTable(
  "service_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    tableId: uuid("table_id")
      .notNull()
      .references(() => restaurantTables.id, { onDelete: "cascade" }),
    status: serviceCallStatusEnum("status").notNull().default("pending"),
    acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("service_calls_restaurant_id_idx").on(table.restaurantId),
    // Powers "does this table already have an active call" lookups — the
    // create route uses this to return the existing call instead of
    // spawning a duplicate every time an impatient guest taps twice.
    index("service_calls_table_id_status_idx").on(table.tableId, table.status),
    // DB-level backstop for the same invariant the route's "look up the
    // existing active call, return it instead of inserting" check is
    // already trying to enforce (see the POST handler's doc comment in
    // src/app/api/order/[token]/service-call/route.ts). That check is a
    // plain SELECT-then-INSERT with no locking, so two requests for the
    // same table arriving close enough together (a genuine race on a
    // flaky mobile network's retry, or someone double-tapping fast enough
    // to beat the round trip) can both pass the SELECT before either
    // INSERT commits, producing two simultaneous "pending" calls for one
    // table. Partial (WHERE status IN pending/acknowledged) so resolved
    // history accumulates freely — only concurrently-ACTIVE calls for a
    // table are constrained to one. Same pattern as
    // user_roles_one_active_per_restaurant_unique above.
    uniqueIndex("service_calls_one_active_per_table_unique")
      .on(table.tableId)
      .where(sql`${table.status} IN ('pending', 'acknowledged')`),
  ],
);

export const serviceCallsRelations = relations(serviceCalls, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [serviceCalls.restaurantId],
    references: [restaurants.id],
  }),
  branch: one(branches, {
    fields: [serviceCalls.branchId],
    references: [branches.id],
  }),
  table: one(restaurantTables, {
    fields: [serviceCalls.tableId],
    references: [restaurantTables.id],
  }),
  acknowledgedBy: one(users, {
    fields: [serviceCalls.acknowledgedByUserId],
    references: [users.id],
  }),
  resolvedBy: one(users, {
    fields: [serviceCalls.resolvedByUserId],
    references: [users.id],
  }),
}));

// Phase 25 — Web Push subscriptions. One row per browser/device that has
// granted notification permission and completed pushManager.subscribe() —
// NOT one row per user, since the same staff member opening the dashboard
// on their phone AND a tablet ends up with two independent subscriptions,
// both of which should receive a push for the same order. `endpoint` is
// unique because re-subscribing the same browser installation (permission
// already granted, service worker re-registers after a cache clear, etc.)
// yields the same endpoint URL from the push service — upsert-by-endpoint
// on save, rather than accumulating duplicate rows that would double-fire
// the notification for that one device.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The push service URL (e.g. FCM for Chrome) this subscription posts
    // to — opaque, can be long, so text rather than varchar.
    endpoint: text("endpoint").notNull(),
    // PushSubscription's encryption keys (from subscription.toJSON().keys),
    // required to encrypt the payload per the Web Push spec — the `web-push`
    // library needs both to call sendNotification.
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    // Diagnostic only (shown in a future "manage devices" UI, not read by
    // any send path) — helps a restaurant owner tell which stale
    // subscription belongs to which retired phone if they ever want to
    // prune manually.
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_idx").on(table.endpoint),
    // Powers "every subscription for this restaurant" — the send path's
    // only query.
    index("push_subscriptions_restaurant_id_idx").on(table.restaurantId),
  ],
);

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [pushSubscriptions.restaurantId],
    references: [restaurants.id],
  }),
  user: one(users, {
    fields: [pushSubscriptions.userId],
    references: [users.id],
  }),
}));
