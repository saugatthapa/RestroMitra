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
  check,
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
    // Commercial Launch Phase B.4 — TOTP multi-factor auth. mfaSecret is
    // set as soon as enrollment STARTS (see mfa.ts) but mfaEnabled only
    // flips to true once the user proves they can actually generate a
    // valid code with it — an unconfirmed secret never gates login.
    // Base32, not encrypted at rest: this codebase has no column-level
    // encryption precedent (passwordHash/tokenHash are all one-way
    // hashes; this is the one secret that must be readable server-side to
    // verify a live 6-digit code against it), same trust boundary as
    // "anyone with DB access already has everything" the rest of this
    // schema assumes.
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaSecret: text("mfa_secret"),
    mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
    // Anti-replay: the RFC 6238 time-step of the last code this user
    // successfully verified. Passed as otplib's `afterTimeStep` on every
    // subsequent verify — without it, a single valid 6-digit code stays
    // usable for its whole ~30s window and could be replayed (e.g.
    // shoulder-surfed, or the two verify calls tests can rapid-fire) more
    // than once.
    mfaLastUsedTimeStep: integer("mfa_last_used_time_step"),
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

// Commercial Launch Phase B.3 — Forgot Password. Single-use, short-lived
// tokens for self-service password reset, deliberately modeled on
// sessions above: only the sha256 hash of the raw token is ever stored
// (the raw token exists only in the emailed link and briefly in memory),
// so a database leak alone can never be replayed into a working reset
// link. `usedAt` (rather than deleting the row on redemption) keeps a
// record for audit/abuse investigation and lets the redemption itself be
// a single CAS UPDATE (`WHERE used_at IS NULL AND expires_at > now()`),
// the same "claim it exactly once" pattern markPaymentReconciled uses.
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    requestIp: varchar("request_ip", { length: 64 }),
    // Short-lived on purpose — 30 minutes, far shorter than a session's 30
    // days, since this token is a bearer credential mailed in plain text.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_token_hash_unique").on(table.tokenHash),
    index("password_reset_tokens_user_id_idx").on(table.userId),
  ],
);

// Commercial Launch Phase B.4 — MFA. A login that reaches here has already
// verified the password; this token represents "this browser proved it
// knows the password, still needs to prove the second factor" and is
// deliberately NOT a session (see session.ts's own comment: session
// creation is the one and only place a real, RBAC-trusted cookie gets
// issued — gating MFA before that call, rather than adding an MFA check
// to every downstream request, keeps requireAuth()/requirePermission()
// completely unaware this feature exists). Short-lived (10 min) and
// single-use, same hash-only-at-rest shape as every other token table
// here — but unlike passwordResetTokens, the raw token here is never a
// cookie or an emailed link: the login route returns it directly in the
// response body and the client holds it in memory only long enough to
// submit it once more with the 6-digit code, avoiding a second cookie
// (and the middleware complexity of a distinct "MFA-pending" auth state)
// for what's normally a single-page, no-navigation step.
export const mfaChallenges = pgTable(
  "mfa_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mfa_challenges_token_hash_unique").on(table.tokenHash),
    index("mfa_challenges_user_id_idx").on(table.userId),
  ],
);

// Commercial Launch Phase B.4 — MFA backup codes, issued 10-at-a-time the
// moment enrollment is confirmed (see mfa.ts). One row per code, only its
// sha256 hash ever stored (same pattern as every other token table on
// this page) — the raw codes are shown to the user exactly once, in the
// enroll-confirm response, and never retrievable again after that.
// usedAt makes each one single-use; regenerating (mfa/backup-codes/
// regenerate) or disabling MFA deletes every row for that user and
// issues/expects a fresh batch.
export const mfaBackupCodes = pgTable(
  "mfa_backup_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mfa_backup_codes_code_hash_unique").on(table.codeHash),
    index("mfa_backup_codes_user_id_idx").on(table.userId),
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
    // RC audit — DB-level backstop alongside the existing Zod validation
    // (createTableSchema/updateTableSchema already reject <= 0); capacity
    // is nullable (a table can be created before capacity is set), so this
    // only rejects an explicit non-positive value, not an unset one.
    check("restaurant_tables_capacity_positive", sql`${table.capacity} IS NULL OR ${table.capacity} > 0`),
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
    // Commercial Launch Phase B.6 — Coupons. Set when the CURRENT discount
    // on this order came from redeeming a coupon (see src/lib/coupons.ts),
    // null when there's no discount or it's a manual one entered via the
    // adjustments route. This is purely a "what's currently applied"
    // pointer, not a historical log — see couponRedemptions for the audit
    // trail of every redemption a coupon has ever had. "set null" (not
    // restrict/cascade) since a coupon can be deactivated without needing
    // to touch every order that ever redeemed it.
    appliedCouponId: uuid("applied_coupon_id").references(() => coupons.id, { onDelete: "set null" }),
    // Commercial Launch Phase B.7 — Table Operations (hold/resume). A
    // staff-initiated pause on this order's forward progress — e.g. the
    // kitchen was asked to wait, or the bill is being held open while the
    // party steps out. Deliberately NOT a new `status` value: `status`
    // drives KDS visibility, order_status_history, reports, and the
    // completion side effects (loyalty/ledger) throughout this app, and
    // folding "held" into that state machine would ripple through all of
    // it. Instead this is an orthogonal flag the status-transition route
    // checks and rejects most transitions against while true (see
    // orders/[orderId]/status/route.ts and hold/resume routes) — the order
    // stays exactly where it was, just frozen, until resumed.
    isOnHold: boolean("is_on_hold").notNull().default(false),
    heldAt: timestamp("held_at", { withTimezone: true }),
    heldByUserId: uuid("held_by_user_id").references(() => users.id, { onDelete: "set null" }),
    holdReason: varchar("hold_reason", { length: 300 }),
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
    // RC audit — DB-level backstop for the money columns; app-layer
    // validation (computeOrderTotals/order-adjustments.ts) already keeps
    // these non-negative, this just closes the gap for anything that
    // writes to this table outside that path (a script, a future route).
    check("orders_amounts_non_negative", sql`
      ${table.subtotalInPaisa} >= 0 AND ${table.taxInPaisa} >= 0 AND
      ${table.discountInPaisa} >= 0 AND ${table.serviceChargeInPaisa} >= 0 AND
      ${table.totalInPaisa} >= 0
    `),
  ],
);

// Commercial Launch Phase B.1 — Order Status History. Written transactionally
// alongside every order-status change (see the orders/[orderId]/status
// route), unlike the generic `audit_logs` entry that route ALSO writes —
// that audit log is a best-effort record written after the transaction
// commits (a crash between the two would leave a gap), and its metadata is
// unstructured JSON, awkward to aggregate over for reporting ("average time
// from confirmed to preparing" would mean parsing every row's JSON blob).
// This table is the durable, structured source of truth: one row per
// transition, in the SAME transaction as the status change itself, with
// fromStatus/toStatus as real enum columns a report can GROUP BY / JOIN on
// directly. It doesn't replace audit_logs (which stays the generic
// who-did-what trail across every feature) — it exists specifically to make
// Order Performance reporting (stage durations, cancellation analytics)
// possible without parsing JSON. See src/lib/order-status-history.ts.
//
// No row is written for order CREATION (the initial implicit "pending")
// — orders.placedAt already reliably marks that moment, so a synthetic
// "null -> pending" row would just duplicate it. The first row here is
// always the first REAL transition (pending -> confirmed, or -> cancelled).
export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    fromStatus: orderStatusEnum("from_status").notNull(),
    toStatus: orderStatusEnum("to_status").notNull(),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    // Only ever populated for a cancellation today (mirrors the `reason`
    // already accepted by updateOrderStatusSchema) — nullable for every
    // other transition, which has no reason to record.
    reason: text("reason"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("order_status_history_order_id_idx").on(table.orderId),
    index("order_status_history_restaurant_id_idx").on(table.restaurantId),
    // Every report query filters/joins on (restaurant, to_status, changed_at)
    // — see getOrderPerformanceStats in reports.ts.
    index("order_status_history_restaurant_to_status_idx").on(table.restaurantId, table.toStatus),
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
    // Commercial-launch Phase A.4 — a FROZEN cost-of-goods snapshot for this
    // line, written once by deductRecipeStockForOrder at the exact moment
    // (confirmed -> preparing) stock is actually deducted, using whatever
    // inventoryItems.costPerUnitInPaisa was THEN. Deliberately never
    // recomputed afterward — costPerUnitInPaisa is a live weighted-average
    // that keeps moving with every later purchase, so re-deriving an old
    // order's COGS from TODAY's cost would silently misstate history (a
    // purchase price change in August would retroactively change March's
    // reported margin). NULL means "no recipe was defined for this item at
    // deduction time" (unknown cost, not zero cost) — the same
    // coverage-honesty distinction getCogsSummary's itemsWithRecipeCount
    // already makes, now captured per-line instead of only as an aggregate
    // ratio. getCogsSummary/getProductProfitability (reports.ts) prefer
    // this snapshot when present and fall back to a live recipe join only
    // for pre-migration rows that predate this column.
    recipeCostInPaisa: integer("recipe_cost_in_paisa"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("order_items_order_id_idx").on(table.orderId),
    // RC audit — app-layer already rejects quantity outside [1, 50]
    // (createStaffOrderSchema et al.); this is the DB-level backstop.
    check("order_items_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "order_items_recipe_cost_non_negative",
      sql`${table.recipeCostInPaisa} IS NULL OR ${table.recipeCostInPaisa} >= 0`,
    ),
  ],
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
    // RC audit — a client-generated retry key, same purpose and pattern as
    // orders.clientRequestId (see that column's comment). The payments
    // route already takes a `FOR UPDATE` lock on the order row, which
    // serializes concurrent requests for the SAME order — but a *legitimate
    // network retry* of a distinct partial payment (e.g. a dropped response
    // after tapping "Cash Rs 500" on a larger bill) previously had no way
    // to be told apart from "staff intentionally recording a second Rs 500
    // payment," and both would pass the remaining-due check and insert.
    // Nullable: most payments are recorded once, live, with no retry
    // concern (the POS UI only sets this when it queues a payment for
    // possible retry).
    clientRequestId: varchar("client_request_id", { length: 100 }),
    note: text("note"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Commercial Launch Phase A.8 — Financial Reconciliation. Cash is
    // deliberately EXCLUDED from this (enforced in
    // src/lib/financial-reconciliation.ts, not here): cash is already
    // reconciled by Cash Register shift close / Daily Closing (the till is
    // physically counted against the expected figure). card/mobile_wallet/
    // other payments never touch a till — the money settles to the
    // restaurant's bank account separately (often days later, sometimes net
    // of a gateway/processor fee), and until now nothing in this app ever
    // tracked whether that settlement was actually confirmed. This is a
    // deliberately MANUAL checklist column, not automated bank-API
    // matching (no such integration exists) — see the master spec's own
    // "report BLOCKED for anything impossible, never fake it" rule: a
    // human confirms against their own bank/gateway statement and marks
    // the payment reconciled here.
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciledByUserId: uuid("reconciled_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("payments_restaurant_id_idx").on(table.restaurantId),
    index("payments_order_id_idx").on(table.orderId),
    // Partial, scoped to (order, clientRequestId) — most payments never set
    // clientRequestId, and a UUID collision across two different orders
    // isn't a real concern, so this only constrains retries of the same
    // payment against the same order (see the column comment above).
    uniqueIndex("payments_order_client_request_id_unique")
      .on(table.orderId, table.clientRequestId)
      .where(sql`${table.clientRequestId} IS NOT NULL`),
    check(
      "payments_reconciled_fields_consistent",
      sql`(${table.reconciledAt} IS NULL AND ${table.reconciledByUserId} IS NULL)
          OR (${table.reconciledAt} IS NOT NULL AND ${table.reconciledByUserId} IS NOT NULL)`,
    ),
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
  // Commercial Launch Phase A.7 — Stock Transfer. Split out from the
  // generic "adjustment" bucket for the same reporting reason "waste" was:
  // a branch-to-branch transfer is an expected, deliberate stock move, not
  // a correction or a loss, and a report lumping it in with "adjustment"
  // would make shrinkage/count-correction numbers look worse than they
  // are. "transfer_out" (negative delta, written at dispatch) and
  // "transfer_in" (positive delta, written at receive) are always a pair
  // referencing the same stock_transfers row via referenceType/referenceId
  // — see src/lib/stock-transfer.ts. Between dispatch and receive the
  // restaurant-wide total (inventoryItems.currentStockMilliunits, which
  // recordStockMovement keeps in lockstep with every individual movement)
  // is deliberately short by the in-transit quantity: it isn't sitting on
  // either branch's shelf right now, so not counting it anywhere is the
  // physically accurate state, not a bug.
  "transfer_out",
  "transfer_in",
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
  // Commercial-launch Phase A.5 — "damaged"/"burned" added to match the
  // spec's named reason list exactly (spoiled/expired/damaged/
  // overproduction/burned/other). Added as NEW values rather than renaming
  // "breakage"/"theft_or_loss" — a rename would need every historical row
  // silently reinterpreted; existing data keeps its original label, new
  // entries can use whichever fits best (damaged for e.g. a dropped tray,
  // breakage for e.g. glassware — both stay valid, distinct options).
  "damaged",
  "burned",
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
    // RC audit — currentStockMilliunits is deliberately excluded (see its
    // own comment: allowed to go negative by design). reorderLevelMilliunits
    // is nullable (null = no alerting configured), so only an explicit
    // negative value is rejected.
    check(
      "inventory_items_reorder_level_non_negative",
      sql`${table.reorderLevelMilliunits} IS NULL OR ${table.reorderLevelMilliunits} >= 0`,
    ),
    check("inventory_items_cost_non_negative", sql`${table.costPerUnitInPaisa} >= 0`),
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
    // Commercial-launch Supplier Dues/AP (Phase A.3) — false (the original,
    // still-default behavior) books the FULL total as an immediately-paid
    // debit at creation (recordPurchaseLedgerEntry, markAsDue: false). true
    // books it as an OUTSTANDING due instead (markAsDue: true) — the
    // supplier extended credit, tracked via the SAME ledger_entries
    // due/settlement machinery Account Books already uses for everything
    // else (dueStatus/settledAmountInPaisa), not a second parallel
    // "amount paid" column on this table.
    isCredit: boolean("is_credit").notNull().default(false),
    // Only meaningful when isCredit is true — when the supplier expects
    // payment. Lives here (not on ledger_entries, which has no due-date
    // concept — it's a generic ledger used for many categories) since a
    // due date is a purchase/invoice-level fact.
    dueDate: date("due_date"),
    isVoided: boolean("is_voided").notNull().default(false),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "set null" }),
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
    check("purchases_total_non_negative", sql`${table.totalInPaisa} >= 0`),
    // All-or-nothing, same pattern as register_shifts' closed-fields
    // CHECK: a purchase is either never voided (both null, isVoided
    // false) or fully voided (both set, isVoided true) — never half.
    check(
      "purchases_voided_fields_consistent",
      sql`(${table.isVoided} = false AND ${table.voidedAt} IS NULL AND ${table.voidedByUserId} IS NULL)
          OR
          (${table.isVoided} = true AND ${table.voidedAt} IS NOT NULL)`,
    ),
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
  (table) => [
    index("purchase_items_purchase_id_idx").on(table.purchaseId),
    check("purchase_items_quantity_positive", sql`${table.quantityMilliunits} > 0`),
    check("purchase_items_unit_cost_non_negative", sql`${table.unitCostInPaisa} >= 0`),
    check("purchase_items_line_total_non_negative", sql`${table.lineTotalInPaisa} >= 0`),
  ],
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
    // Commercial Launch Phase B.5 — Customer Credit. Links this entry to a
    // specific CRM customer record, IN ADDITION TO counterpartyName (which
    // stays free text for the common case of no CRM record at all) —
    // populated automatically when a completed order that finishes unpaid/
    // partially paid is linked to a customer (see recordSalesLedgerEntry's
    // call site in orders/[orderId]/status/route.ts), or manually when a
    // staff member links a manual Account Books entry to a customer. This
    // is deliberately NOT a second ledger/table for "customer credit" — a
    // customer's outstanding balance is just "their outstanding
    // ledgerEntries rows, summed" (see getCustomerOutstandingBalance/
    // settleCustomerCredit in ledger.ts), reusing the exact same
    // dueStatus/settledAmountInPaisa/settleLedgerDue machinery Account
    // Books' own due tracking already has, rather than duplicating it.
    // onDelete "set null" rather than "cascade": a customer record is never
    // hard-deleted anywhere in this app (see customers PATCH route's own
    // comment — it's a soft isActive toggle), but financial history must
    // never disappear even in the hypothetical case a customer row is
    // removed some other way.
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
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
    index("ledger_entries_customer_id_idx").on(table.customerId),
  ],
);

// ---------------------------------------------------------------------------
// Coupons — Commercial Launch Phase B.6. A reusable, staff-defined promo
// code that resolves into the SAME discountType/discountValue slot orders
// already has (see orders.discountType's own comment) — reuses
// computeDiscountInPaisa (order-adjustments.ts) unchanged rather than a
// parallel pricing formula; a coupon is just another way to fill that one
// discount slot, so it's mutually exclusive with a manual discount on the
// same order (applying one replaces the other — see src/lib/coupons.ts).
//
// usageCount is a maintained running total (same "one choke point,
// CAS-guarded against usageLimit" pattern as mfaBackupCodes/loyalty
// balances), with couponRedemptions as the append-only audit trail of
// every individual use — mirroring loyaltyTransactions' own
// running-total-plus-ledger split.
// ---------------------------------------------------------------------------

export const coupons = pgTable(
  "coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    // Always stored upper-cased (see coupons.ts) so lookup is a plain
    // equality check, not a case-insensitive query.
    code: varchar("code", { length: 30 }).notNull(),
    discountType: discountTypeEnum("discount_type").notNull(),
    // Same convention as orders.discountValue: basis points for
    // "percentage", paisa for "flat".
    discountValue: integer("discount_value").notNull(),
    // Caps a PERCENTAGE coupon's actual paisa discount on a large order
    // (e.g. "20% off, up to Rs 200") — meaningless/ignored for a "flat"
    // coupon, which is already a fixed paisa amount. Null = no cap.
    maxDiscountInPaisa: integer("max_discount_in_paisa"),
    // Order subtotal must reach this before the coupon resolves at all —
    // null = no minimum.
    minOrderSubtotalInPaisa: integer("min_order_subtotal_in_paisa"),
    // Total redemptions allowed across all orders/customers — null =
    // unlimited. Enforced via a compare-and-swap on usageCount at redeem
    // time (see redeemCoupon in coupons.ts), not just this check.
    usageLimit: integer("usage_limit"),
    usageCount: integer("usage_count").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("coupons_restaurant_id_idx").on(table.restaurantId),
    uniqueIndex("coupons_restaurant_code_unique").on(table.restaurantId, table.code),
    check("coupons_usage_count_non_negative", sql`${table.usageCount} >= 0`),
  ],
);

export const couponRedemptions = pgTable(
  "coupon_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // The actual paisa amount this redemption discounted the order by —
    // stored rather than re-derived, since a percentage coupon's paisa
    // value depends on that specific order's subtotal at redemption time.
    discountInPaisa: integer("discount_in_paisa").notNull(),
    redeemedByUserId: uuid("redeemed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("coupon_redemptions_restaurant_id_idx").on(table.restaurantId),
    index("coupon_redemptions_coupon_id_idx").on(table.couponId),
    index("coupon_redemptions_order_id_idx").on(table.orderId),
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
    // Commercial-launch Phase A.5 — a FROZEN cost basis for this movement,
    // written once by recordStockMovement using inventoryItems'
    // costPerUnitInPaisa at the exact moment this movement happened (never
    // recomputed later). Same reasoning as orderItems.recipeCostInPaisa:
    // costPerUnitInPaisa is a live weighted average that keeps moving with
    // every later purchase, so a wastage/COGS report re-deriving an old
    // movement's cost from TODAY's rate would silently misstate history.
    // unitCostInPaisaSnapshot is cost per ONE WHOLE UNIT (matching every
    // other costPerUnitInPaisa-shaped column in this schema);
    // totalCostInPaisaSnapshot is that rate applied to this movement's own
    // |quantityDeltaMilliunits|. Both nullable — NULL only for rows written
    // before this column existed; getWastageSummary (reports.ts) prefers
    // these when present and falls back to a live join otherwise, exactly
    // like getCogsSummary already does for orderItems.recipeCostInPaisa.
    unitCostInPaisaSnapshot: integer("unit_cost_in_paisa_snapshot"),
    totalCostInPaisaSnapshot: integer("total_cost_in_paisa_snapshot"),
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
    check(
      "stock_movements_unit_cost_snapshot_non_negative",
      sql`${table.unitCostInPaisaSnapshot} IS NULL OR ${table.unitCostInPaisaSnapshot} >= 0`,
    ),
    check(
      "stock_movements_total_cost_snapshot_non_negative",
      sql`${table.totalCostInPaisaSnapshot} IS NULL OR ${table.totalCostInPaisaSnapshot} >= 0`,
    ),
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
// Physical Stock Count (Commercial Launch Phase A.6). A `stockCounts` header
// row (one per counting session, scoped to one branch) plus `stockCountItems`
// line rows (one per item counted). Workflow, enforced in
// src/lib/stock-count.ts, never here:
//   open -> (submit) -> either
//     - applied      immediately, if every item's variance is within the
//                     documented "large variance" threshold (auto-apply,
//                     MANAGE_INVENTORY is sufficient)
//     - pending_approval, if ANY item's variance exceeds the threshold —
//                     requires APPROVE_STOCK_COUNT to move on to:
//         -> applied   (approve: variances are written to the stock ledger)
//         -> rejected  (reject: count is kept for the audit trail, but NO
//                       stock movement is ever written)
// "applied" is terminal either way — once variances are written via
// recordStockMovement() they follow that ledger's own append-only-correction
// model (a mistaken applied count needs a fresh manual adjustment/count to
// correct, same as every other stock_movements row; there is deliberately no
// "un-apply").
//
// systemQuantityMilliunits/unitCostInPaisaSnapshot on each line are captured
// at the moment the item is ADDED to the count (from branch_inventory_levels
// and inventory_items.costPerUnitInPaisa respectively) — a snapshot, not a
// live join, for the exact same reason orderItems.recipeCostInPaisa and
// stock_movements.unitCostInPaisaSnapshot are snapshots: so a later purchase
// changing the item's cost, or a later sale changing its stock, never
// silently rewrites what this count actually found. Known, accepted
// limitation: a sale rung up WHILE this count is still open (between a line
// being added and the count being submitted) is not reflected in that line's
// systemQuantityMilliunits snapshot, which can produce a variance that isn't
// really theft/spoilage/error — just a normal sale mid-count. Real
// restaurants handle this operationally (count during a lull, or pause
// sales for the branch/item being counted); reconciling live sales against
// an in-progress count is out of scope for this phase.
//
// Variance (physical - system) and its paisa value are DERIVED in
// application code from the two snapshot columns, never stored — same
// "compute from source columns, don't duplicate" convention
// getSupplierDueReport uses for outstandingInPaisa.
// ---------------------------------------------------------------------------

export const stockCountStatusEnum = pgEnum("stock_count_status", [
  "open",
  "pending_approval",
  "applied",
  "rejected",
]);

export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    status: stockCountStatusEnum("status").notNull().default("open"),
    notes: text("notes"),
    countedByUserId: uuid("counted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    // Denormalized from the line items at submit time, so listing/filtering
    // counts (e.g. "show me everything awaiting my approval") never needs a
    // join/aggregate over stock_count_items just to know this.
    hasLargeVariance: boolean("has_large_variance").notNull().default(false),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedByUserId: uuid("rejected_by_user_id").references(() => users.id, { onDelete: "set null" }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: varchar("rejection_reason", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stock_counts_restaurant_id_idx").on(table.restaurantId),
    index("stock_counts_branch_id_idx").on(table.branchId),
    index("stock_counts_status_idx").on(table.status),
    // All-or-nothing pairs, same pattern as purchases_voided_fields_consistent.
    check(
      "stock_counts_approved_fields_consistent",
      sql`(${table.approvedByUserId} IS NULL AND ${table.approvedAt} IS NULL)
          OR (${table.approvedByUserId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
    check(
      "stock_counts_rejected_fields_consistent",
      sql`(${table.status} <> 'rejected' AND ${table.rejectedByUserId} IS NULL AND ${table.rejectedAt} IS NULL AND ${table.rejectionReason} IS NULL)
          OR (${table.status} = 'rejected' AND ${table.rejectedByUserId} IS NOT NULL AND ${table.rejectedAt} IS NOT NULL AND ${table.rejectionReason} IS NOT NULL)`,
    ),
    // A count still being entered has no submittedAt; every other status
    // implies it was submitted at some point.
    check(
      "stock_counts_submitted_fields_consistent",
      sql`(${table.status} = 'open' AND ${table.submittedAt} IS NULL)
          OR (${table.status} <> 'open' AND ${table.submittedAt} IS NOT NULL)`,
    ),
  ],
);

export const stockCountItems = pgTable(
  "stock_count_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stockCountId: uuid("stock_count_id")
      .notNull()
      .references(() => stockCounts.id, { onDelete: "cascade" }),
    inventoryItemId: uuid("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "restrict" }),
    // Snapshot of branch_inventory_levels.currentStockMilliunits (0 if no
    // row existed yet) at the moment this line was added — see this
    // section's header comment.
    systemQuantityMilliunits: integer("system_quantity_milliunits").notNull(),
    // Null until staff enters what they actually counted.
    physicalQuantityMilliunits: integer("physical_quantity_milliunits"),
    // Snapshot of inventory_items.cost_per_unit_in_paisa at the moment this
    // line was added — used to preview/report the variance's paisa value.
    // The stock movement eventually written by an applied count freezes its
    // OWN cost snapshot at apply time via recordStockMovement, which may
    // differ slightly if the item's cost moved between count and approval;
    // that's expected, same "frozen at the moment it happened" philosophy
    // as every other snapshot column in this schema.
    unitCostInPaisaSnapshot: integer("unit_cost_in_paisa_snapshot").notNull(),
    note: text("note"),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stock_count_items_stock_count_id_idx").on(table.stockCountId),
    index("stock_count_items_inventory_item_id_idx").on(table.inventoryItemId),
    uniqueIndex("stock_count_items_count_item_unique").on(table.stockCountId, table.inventoryItemId),
    // systemQuantityMilliunits deliberately has NO non-negative check — a
    // branch's cached stock is allowed to go negative by design (see
    // branch_inventory_levels' own section comment / PHASE_7_NOTES.md), and
    // a count snapshot must faithfully record whatever that value actually
    // was, negative or not.
    check("stock_count_items_unit_cost_non_negative", sql`${table.unitCostInPaisaSnapshot} >= 0`),
    check(
      "stock_count_items_physical_quantity_non_negative",
      sql`${table.physicalQuantityMilliunits} IS NULL OR ${table.physicalQuantityMilliunits} >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Stock Transfer (Commercial Launch Phase A.7). A `stockTransfers` header
// row (one per branch-to-branch move) plus `stockTransferItems` line rows.
// Lifecycle, enforced in src/lib/stock-transfer.ts, never here:
//   requested -> approved -> dispatched -> received   (terminal)
//   requested -> approved -> cancelled                (terminal)
//   requested -> cancelled                             (terminal)
// Cancel is deliberately ONLY available before dispatch. Once dispatched,
// the goods have physically left the source branch (dispatch is the moment
// stock is deducted there — see stockMovementTypeEnum's "transfer_out"
// comment), so there is nothing left to cleanly "cancel" the way an
// unsettled purchase can be voided; a dispatched transfer must be received
// (even a received quantity of 0, if literally nothing arrived — see
// stockTransferItems.receivedQuantityMilliunits below), and any real-world
// discrepancy between what left and what arrived is visible on the record
// itself for the restaurant to investigate, not auto-explained away.
//
// Quantities are integer milliunits, costs untouched by this table
// entirely — a transfer only moves WHICH BRANCH holds existing stock, never
// its restaurant-wide weighted-average cost (that stays exactly as
// applyPurchaseCosting already computed it), so there is no cost-snapshot
// column here. The stock_movements rows dispatch/receive write (type
// transfer_out/transfer_in) already carry their own frozen cost snapshot
// via recordStockMovement, same as every other movement type.
// ---------------------------------------------------------------------------

export const stockTransferStatusEnum = pgEnum("stock_transfer_status", [
  "requested",
  "approved",
  "dispatched",
  "received",
  "cancelled",
]);

export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    fromBranchId: uuid("from_branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    toBranchId: uuid("to_branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    status: stockTransferStatusEnum("status").notNull().default("requested"),
    notes: text("notes"),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    dispatchedByUserId: uuid("dispatched_by_user_id").references(() => users.id, { onDelete: "set null" }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    receivedByUserId: uuid("received_by_user_id").references(() => users.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, { onDelete: "set null" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: varchar("cancellation_reason", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stock_transfers_restaurant_id_idx").on(table.restaurantId),
    index("stock_transfers_from_branch_id_idx").on(table.fromBranchId),
    index("stock_transfers_to_branch_id_idx").on(table.toBranchId),
    index("stock_transfers_status_idx").on(table.status),
    check("stock_transfers_branches_distinct", sql`${table.fromBranchId} <> ${table.toBranchId}`),
    // All-or-nothing pairs/triples, same pattern used throughout this
    // schema (purchases_voided_fields_consistent, stock_counts_*).
    check(
      "stock_transfers_approved_fields_consistent",
      sql`(${table.approvedByUserId} IS NULL AND ${table.approvedAt} IS NULL)
          OR (${table.approvedByUserId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
    check(
      "stock_transfers_dispatched_fields_consistent",
      sql`(${table.dispatchedByUserId} IS NULL AND ${table.dispatchedAt} IS NULL)
          OR (${table.dispatchedByUserId} IS NOT NULL AND ${table.dispatchedAt} IS NOT NULL)`,
    ),
    check(
      "stock_transfers_received_fields_consistent",
      sql`(${table.receivedByUserId} IS NULL AND ${table.receivedAt} IS NULL)
          OR (${table.receivedByUserId} IS NOT NULL AND ${table.receivedAt} IS NOT NULL)`,
    ),
    check(
      "stock_transfers_cancelled_fields_consistent",
      sql`(${table.status} <> 'cancelled' AND ${table.cancelledByUserId} IS NULL AND ${table.cancelledAt} IS NULL AND ${table.cancellationReason} IS NULL)
          OR (${table.status} = 'cancelled' AND ${table.cancelledByUserId} IS NOT NULL AND ${table.cancelledAt} IS NOT NULL AND ${table.cancellationReason} IS NOT NULL)`,
    ),
  ],
);

export const stockTransferItems = pgTable(
  "stock_transfer_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stockTransferId: uuid("stock_transfer_id")
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),
    inventoryItemId: uuid("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "restrict" }),
    // Requested/dispatched quantity — set at creation, fixed thereafter
    // (the request itself can still be edited by re-creating it; there is
    // no in-place quantity edit once other staff may already be acting on
    // it — same "no partial mutation of a shared, already-visible record"
    // instinct as purchases having no edit endpoint).
    quantityMilliunits: integer("quantity_milliunits").notNull(),
    // Null until received. What actually arrived — may legitimately differ
    // from quantityMilliunits (breakage/spillage in transit); the stock
    // movement recorded at receive uses THIS value, not the dispatched
    // one, so the destination branch's stock reflects reality. The gap
    // between the two, if any, is left as a visible fact on the record for
    // the restaurant to investigate/record separately (e.g. as wastage) —
    // this table does not guess or auto-explain the cause.
    receivedQuantityMilliunits: integer("received_quantity_milliunits"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stock_transfer_items_stock_transfer_id_idx").on(table.stockTransferId),
    index("stock_transfer_items_inventory_item_id_idx").on(table.inventoryItemId),
    uniqueIndex("stock_transfer_items_transfer_item_unique").on(table.stockTransferId, table.inventoryItemId),
    check("stock_transfer_items_quantity_positive", sql`${table.quantityMilliunits} > 0`),
    check(
      "stock_transfer_items_received_quantity_non_negative",
      sql`${table.receivedQuantityMilliunits} IS NULL OR ${table.receivedQuantityMilliunits} >= 0`,
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
    // Commercial Launch Phase B.5 — Customer Credit. Null = no limit set
    // (the default; credit is tracked but never capped). When set, it's an
    // ADVISORY ceiling only — surfaced in the CRM UI as a warning once a
    // customer's outstanding ledger balance (see getCustomerOutstandingBalance
    // in ledger.ts) reaches or exceeds it, not a hard block on order
    // completion. A hard block would mean the order-completion status
    // transition (orders/[orderId]/status/route.ts) can newly fail for a
    // reason unrelated to the order itself, which is a much more invasive
    // change than this feature calls for — see that route's own "->completed
    // is also the single point a sale is booked into Account Books" comment;
    // completion always succeeds, same as today, and staff see the warning
    // on the customer's own profile to decide for themselves.
    creditLimitInPaisa: integer("credit_limit_in_paisa"),
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
    check("expenses_amount_positive", sql`${table.amountInPaisa} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Cash Register / Shift Management (Commercial Launch Phase A.1).
//
// One `registerShifts` row per open/close cycle of one physical till
// ("registerName" — most single-counter restaurants never set more than
// "Main Register", the default, but the schema allows more than one
// concurrently-open till per branch). The backend is the source of truth
// for "expected cash," never the UI: expected cash is DERIVED at read time
// from data that already exists elsewhere rather than duplicated —
//   + opening float          -> registerShifts.openingCashInPaisa
//   + net cash sales/refunds -> SUM(payments.amountInPaisa) WHERE method
//                                = 'cash' for orders at this branch, in
//                                [openedAt, now/closedAt) — already signed
//                                (refunds are negative rows), so one SUM
//                                nets both without a second query
//   + cash additions         -> SUM from registerCashMovements type='addition'
//   - cash drops             -> SUM from registerCashMovements type='drop'
//   - cash payouts           -> SUM from registerCashMovements type='payout'
//   - cash expenses          -> SUM(expenses.amountInPaisa) WHERE
//                                paymentMethod = 'cash' AND status = 'paid'
//                                AND branchId = this branch, paidAt in range
// See computeExpectedCashInPaisa in src/lib/cash-register.ts — the ONE
// place this formula is allowed to live, same convention as
// computeOrderTotals for order pricing.
//
// actualCashInPaisa/expectedCashInPaisa/varianceInPaisa are null while a
// shift is open and are FROZEN (snapshotted) at close time — re-running
// the same query later (after more orders land against the now-closed
// shift's time window, which can't happen since new payments can't be
// backdated into a closed window, but as a defense-in-depth principle)
// must never silently change a closed shift's recorded numbers. Corrections
// to a closed shift go through registerShiftCorrections below, never a
// direct UPDATE that overwrites history.
// ---------------------------------------------------------------------------

export const registerShiftStatusEnum = pgEnum("register_shift_status", ["open", "closed"]);

export const registerCashMovementTypeEnum = pgEnum("register_cash_movement_type", [
  // Cash physically added to the till mid-shift (e.g. topping up change).
  "addition",
  // Cash physically removed from the till mid-shift for safekeeping (e.g.
  // a manager pulling large bills to the safe) — still expected to
  // reconcile at close, just not sitting in the drawer anymore.
  "drop",
  // Cash paid out of the till directly for something (a quick supply
  // run) — distinct from the Expenses module's approval workflow; this is
  // the "till source of truth," Expenses can separately record the same
  // spend for categorized reporting if staff choose to.
  "payout",
]);

export const registerShifts = pgTable(
  "register_shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    registerName: varchar("register_name", { length: 60 }).notNull().default("Main Register"),
    status: registerShiftStatusEnum("status").notNull().default("open"),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openingCashInPaisa: integer("opening_cash_in_paisa").notNull(),
    openingNotes: text("opening_notes"),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Staff-counted physical cash at close time.
    actualCashInPaisa: integer("actual_cash_in_paisa"),
    // Snapshot of computeExpectedCashInPaisa() at the moment of close —
    // frozen, never recomputed after the fact (see block comment above).
    expectedCashInPaisa: integer("expected_cash_in_paisa"),
    // actualCashInPaisa - expectedCashInPaisa, snapshotted alongside it.
    varianceInPaisa: integer("variance_in_paisa"),
    closingNotes: text("closing_notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("register_shifts_restaurant_id_idx").on(table.restaurantId),
    index("register_shifts_branch_id_idx").on(table.branchId),
    index("register_shifts_status_idx").on(table.status),
    // "same cashier can't have two active shifts" — global across
    // branches, matching the spec's literal wording (a person is either
    // running a till right now, or they're not).
    uniqueIndex("register_shifts_one_open_per_cashier")
      .on(table.openedByUserId)
      .where(sql`${table.status} = 'open'`),
    // "same branch/register can't have two active shifts."
    uniqueIndex("register_shifts_one_open_per_branch_register")
      .on(table.branchId, table.registerName)
      .where(sql`${table.status} = 'open'`),
    check("register_shifts_opening_cash_non_negative", sql`${table.openingCashInPaisa} >= 0`),
    check(
      "register_shifts_actual_cash_non_negative",
      sql`${table.actualCashInPaisa} IS NULL OR ${table.actualCashInPaisa} >= 0`,
    ),
    // Closed-shift fields are all-or-nothing: a shift is either fully open
    // (every closing field null) or fully closed (every closing field
    // set) — never a half-closed row.
    check(
      "register_shifts_closed_fields_consistent",
      sql`(${table.status} = 'open' AND ${table.closedByUserId} IS NULL AND ${table.closedAt} IS NULL AND ${table.actualCashInPaisa} IS NULL AND ${table.expectedCashInPaisa} IS NULL AND ${table.varianceInPaisa} IS NULL)
          OR
          (${table.status} = 'closed' AND ${table.closedAt} IS NOT NULL AND ${table.actualCashInPaisa} IS NOT NULL AND ${table.expectedCashInPaisa} IS NOT NULL AND ${table.varianceInPaisa} IS NOT NULL)`,
    ),
  ],
);

export const registerCashMovements = pgTable(
  "register_cash_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => registerShifts.id, { onDelete: "cascade" }),
    type: registerCashMovementTypeEnum("type").notNull(),
    // Always a positive magnitude — direction comes from `type`, not sign,
    // matching purchaseItems/expenses' convention (unlike payments/
    // ledgerEntries, which are signed). computeExpectedCashInPaisa applies
    // the sign per type.
    amountInPaisa: integer("amount_in_paisa").notNull(),
    reason: varchar("reason", { length: 300 }),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("register_cash_movements_shift_id_idx").on(table.shiftId),
    check("register_cash_movements_amount_positive", sql`${table.amountInPaisa} > 0`),
  ],
);

// A closed shift's actualCash/expectedCash/variance are never overwritten
// directly (see registerShifts' block comment) — a manager/owner
// correction instead appends a row here AND updates the shift's snapshot
// fields to the corrected values, so the row-level history always shows
// exactly what changed, by whom, and why, while the shift itself always
// reflects the current, corrected truth (same "correction preserves the
// original, never silently rewrites" pattern the spec asks for).
export const registerShiftCorrections = pgTable(
  "register_shift_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => registerShifts.id, { onDelete: "cascade" }),
    correctedByUserId: uuid("corrected_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    previousActualCashInPaisa: integer("previous_actual_cash_in_paisa").notNull(),
    newActualCashInPaisa: integer("new_actual_cash_in_paisa").notNull(),
    previousVarianceInPaisa: integer("previous_variance_in_paisa").notNull(),
    newVarianceInPaisa: integer("new_variance_in_paisa").notNull(),
    reason: varchar("reason", { length: 300 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("register_shift_corrections_shift_id_idx").on(table.shiftId)],
);

// ---------------------------------------------------------------------------
// Daily Closing / "Daily Close Lock" (Commercial Launch Phase A.2).
//
// One row per (restaurant, branch, business day) that has actually been
// closed — the row's mere existence IS the lock: closeDailyBusiness()
// (src/lib/daily-closing.ts) refuses to insert a second row for the same
// (restaurantId, branchId, businessDate) via the unique index below, and
// the refunds route consults isBusinessDateClosed() to require the extra
// MANAGE_DAILY_CLOSING trust level for a refund landing on an
// already-closed day (see that route's own comment) rather than silently
// letting ordinary staff edit a locked period's numbers.
//
// snapshotJson freezes EVERY line item the Daily Closing screen showed at
// the moment of close (see DailyClosingSnapshot in daily-closing.ts) —
// deliberately jsonb rather than dozens of individual columns, since this
// is fundamentally "the report, frozen," not a row application code
// queries piecemeal. The four numeric columns below are pulled out
// separately anyway, NOT as a second source of truth (they're written
// from the exact same snapshot in the same insert) but so a shift/day
// history list can sort/filter without parsing JSON for every row.
// ---------------------------------------------------------------------------

export const dailyCloses = pgTable(
  "daily_closes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    // YYYY-MM-DD — the RESTAURANT's own calendar day (restaurantDate()),
    // never the server's UTC day. See restaurant-date.ts's own doc
    // comment for why this distinction matters for a Nepal-timezone app.
    businessDate: date("business_date").notNull(),
    closedByUserId: uuid("closed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    revenueInPaisa: integer("revenue_in_paisa").notNull(),
    cogsInPaisa: integer("cogs_in_paisa").notNull(),
    netProfitInPaisa: integer("net_profit_in_paisa").notNull(),
    // Null when no register shift was closed at this branch on this day —
    // "nothing to reconcile" is a real, honestly-representable state, not
    // fabricated as a zero variance (see spec section 9's "do not
    // fabricate a value that can't be calculated" instruction).
    cashVarianceInPaisa: integer("cash_variance_in_paisa"),
    notes: text("notes"),
    snapshotJson: jsonb("snapshot_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("daily_closes_restaurant_id_idx").on(table.restaurantId),
    index("daily_closes_branch_id_idx").on(table.branchId),
    uniqueIndex("daily_closes_restaurant_branch_date_unique").on(
      table.restaurantId,
      table.branchId,
      table.businessDate,
    ),
  ],
);

export const dailyClosesRelations = relations(dailyCloses, ({ one }) => ({
  restaurant: one(restaurants, { fields: [dailyCloses.restaurantId], references: [restaurants.id] }),
  branch: one(branches, { fields: [dailyCloses.branchId], references: [branches.id] }),
  closedBy: one(users, { fields: [dailyCloses.closedByUserId], references: [users.id] }),
}));

export const registerShiftsRelations = relations(registerShifts, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [registerShifts.restaurantId],
    references: [restaurants.id],
  }),
  branch: one(branches, {
    fields: [registerShifts.branchId],
    references: [branches.id],
  }),
  openedBy: one(users, {
    fields: [registerShifts.openedByUserId],
    references: [users.id],
  }),
  closedBy: one(users, {
    fields: [registerShifts.closedByUserId],
    references: [users.id],
  }),
  cashMovements: many(registerCashMovements),
  corrections: many(registerShiftCorrections),
}));

export const registerCashMovementsRelations = relations(registerCashMovements, ({ one }) => ({
  shift: one(registerShifts, {
    fields: [registerCashMovements.shiftId],
    references: [registerShifts.id],
  }),
  recordedBy: one(users, {
    fields: [registerCashMovements.recordedByUserId],
    references: [users.id],
  }),
}));

export const registerShiftCorrectionsRelations = relations(registerShiftCorrections, ({ one }) => ({
  shift: one(registerShifts, {
    fields: [registerShiftCorrections.shiftId],
    references: [registerShifts.id],
  }),
  correctedBy: one(users, {
    fields: [registerShiftCorrections.correctedByUserId],
    references: [users.id],
  }),
}));

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
    check("staff_salary_configs_amount_positive", sql`${table.amountInPaisa} > 0`),
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
    // Commercial Launch Phase B.2 — Payroll Upgrades. Populated only when
    // this payment was recorded via the computed-pay flow (see
    // src/lib/payroll.ts's getPayrollComputation) — null for a manually-
    // typed one-off payment (bonus, advance) that never went through that
    // computation. Lets a later reviewer see "the system computed X based
    // on Y days / Z hours; W was actually paid" and judge whether a manual
    // override was reasonable, without re-running the computation against
    // possibly-since-changed attendance data. amountInPaisa above is
    // always the ACTUAL amount paid (which a manager can freely edit from
    // the computed suggestion) — these three columns are read-only record
    // of what the system proposed.
    computedAmountInPaisa: integer("computed_amount_in_paisa"),
    attendanceMinutesSnapshot: integer("attendance_minutes_snapshot"),
    attendanceDaysSnapshot: integer("attendance_days_snapshot"),
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
    check("payroll_payments_amount_positive", sql`${table.amountInPaisa} > 0`),
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
    // Estimated dining duration — defines the overlap window
    // assertNoReservationOverlap() checks against (src/lib/tables.ts).
    // RC audit note: this comment previously said double-booking was only
    // a soft UI warning — that's stale. It's a real, transaction-enforced
    // guard (a `FOR UPDATE` lock on the table row, taken before the
    // overlap check runs) — see requireTableRowLock in tables.ts.
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
    check("reservations_party_size_positive", sql`${table.partySize} > 0`),
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
  passwordResetTokens: many(passwordResetTokens),
  mfaChallenges: many(mfaChallenges),
  mfaBackupCodes: many(mfaBackupCodes),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, { fields: [passwordResetTokens.userId], references: [users.id] }),
}));

export const mfaChallengesRelations = relations(mfaChallenges, ({ one }) => ({
  user: one(users, { fields: [mfaChallenges.userId], references: [users.id] }),
}));

export const mfaBackupCodesRelations = relations(mfaBackupCodes, ({ one }) => ({
  user: one(users, { fields: [mfaBackupCodes.userId], references: [users.id] }),
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
  statusHistory: many(orderStatusHistory),
}));

export const orderStatusHistoryRelations = relations(orderStatusHistory, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [orderStatusHistory.restaurantId],
    references: [restaurants.id],
  }),
  order: one(orders, {
    fields: [orderStatusHistory.orderId],
    references: [orders.id],
  }),
  changedBy: one(users, {
    fields: [orderStatusHistory.changedByUserId],
    references: [users.id],
  }),
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
  reconciledBy: one(users, {
    fields: [payments.reconciledByUserId],
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

export const stockCountsRelations = relations(stockCounts, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [stockCounts.restaurantId],
    references: [restaurants.id],
  }),
  branch: one(branches, {
    fields: [stockCounts.branchId],
    references: [branches.id],
  }),
  countedBy: one(users, {
    fields: [stockCounts.countedByUserId],
    references: [users.id],
  }),
  approvedBy: one(users, {
    fields: [stockCounts.approvedByUserId],
    references: [users.id],
  }),
  rejectedBy: one(users, {
    fields: [stockCounts.rejectedByUserId],
    references: [users.id],
  }),
  items: many(stockCountItems),
}));

export const stockCountItemsRelations = relations(stockCountItems, ({ one }) => ({
  stockCount: one(stockCounts, {
    fields: [stockCountItems.stockCountId],
    references: [stockCounts.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [stockCountItems.inventoryItemId],
    references: [inventoryItems.id],
  }),
}));

export const stockTransfersRelations = relations(stockTransfers, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [stockTransfers.restaurantId],
    references: [restaurants.id],
  }),
  fromBranch: one(branches, {
    fields: [stockTransfers.fromBranchId],
    references: [branches.id],
  }),
  toBranch: one(branches, {
    fields: [stockTransfers.toBranchId],
    references: [branches.id],
  }),
  requestedBy: one(users, {
    fields: [stockTransfers.requestedByUserId],
    references: [users.id],
  }),
  approvedBy: one(users, {
    fields: [stockTransfers.approvedByUserId],
    references: [users.id],
  }),
  dispatchedBy: one(users, {
    fields: [stockTransfers.dispatchedByUserId],
    references: [users.id],
  }),
  receivedBy: one(users, {
    fields: [stockTransfers.receivedByUserId],
    references: [users.id],
  }),
  cancelledBy: one(users, {
    fields: [stockTransfers.cancelledByUserId],
    references: [users.id],
  }),
  items: many(stockTransferItems),
}));

export const stockTransferItemsRelations = relations(stockTransferItems, ({ one }) => ({
  stockTransfer: one(stockTransfers, {
    fields: [stockTransferItems.stockTransferId],
    references: [stockTransfers.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [stockTransferItems.inventoryItemId],
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
