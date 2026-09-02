/**
 * Phase 2 (P1) — shared seeding/teardown helpers for the E2E specs.
 *
 * Deliberately mirrors the pattern already established by the DB-backed
 * integration tests in src/db/__tests__/ (e.g. tables-status-lifecycle.test.ts):
 * every spec creates its own restaurant/branch/users with a random suffix
 * (so parallel spec files never collide) and deletes exactly what it
 * created in an `afterAll`/`afterEach`, rather than relying on a shared
 * fixture or a wipe-the-database reset. This runs against the real dev
 * database (DATABASE_URL from .env.local, loaded by playwright.config.ts)
 * — there is no separate "e2e" database in this project, same as how the
 * vitest integration tests already share the dev DB.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  users,
  restaurants,
  branches,
  userRoles,
  categories,
  menuItems,
  restaurantTables,
  reservations,
  orders,
  platformImpersonationSessions,
  inventoryItems,
  recipeItems,
  staffSalaryConfigs,
  payrollPayments,
  sessions,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import type { AssignableStaffRole } from "@/lib/staff-roles";
import type { InventoryUnit } from "@/lib/inventory-units";
// Not `import { generateMfaEnrollment } from "@/lib/auth/mfa"`: that module
// starts with `import "server-only"`, which vitest tolerates only because
// vitest.config.mts aliases "server-only" to a no-op mock — Playwright's
// test runner has no equivalent alias, so pulling it in here throws "This
// module cannot be imported from a Client Component module" the moment
// this file loads, before any test even runs. Calling otplib's own
// `generateSecret` directly is not a shortcut around that: it's the exact
// same call generateMfaEnrollment itself makes (see mfa.ts) — a real
// RFC 6238 base32 secret from the same well-audited library, not a
// hand-rolled one.
import { generateSecret } from "otplib";

/** Nepal mobile numbers must match /^9[678]\d{8}$/ (see
 * src/lib/validation/auth.ts) — the real login form round-trips through
 * that validator, so a seeded user's phone has to satisfy it for real,
 * unlike a plain DB-only integration test that never goes through the
 * schema. */
export function randomPhone(): string {
  const prefix = ["96", "97", "98"][Math.floor(Math.random() * 3)];
  const rest = Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, "0");
  return `${prefix}${rest}`;
}

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const E2E_PASSWORD = "E2eTestPass123";

export type SeededRestaurant = {
  restaurantId: string;
  branchId: string;
  slug: string;
  name: string;
  ownerId: string;
  ownerPhone: string;
  // Phase 2 (P1) extension — user ids for any staff members seeded via
  // seedStaffMember() beyond the owner. Mutated in place by that helper
  // (rather than requiring every caller to track/pass its own list) so
  // teardownRestaurant can clean every account a spec created without each
  // spec file having to remember to do it itself.
  extraUserIds: string[];
  // Gap-audit P1 extension — set only when seedOwnerRestaurant was called
  // with `mfaEnabled: true` (see requireOwnerMfaEnabled/guard.ts, applied
  // to every sensitive owner-only route — payroll payments among them).
  // A spec exercising one of those routes needs the owner to actually have
  // MFA enrolled, same "seed the end state directly" convention as
  // seedPlatformAdmin's mfaSecret, and then submit a live TOTP code
  // through the real two-step /login form — see loginAsOwnerWithMfa below.
  mfaSecret: string | null;
};

/**
 * Seeds one restaurant + main branch + an owner user with an active
 * "owner" role grant and a real bcrypt password hash (so the real
 * /api/auth/login route accepts it). subscriptionStatus/trialEndsAt are
 * left at their column defaults ("trialing" / null) — computeSubscriptionAccess
 * treats a null trialEndsAt as "trial never expires", so this doesn't
 * trip the dashboard layout's billing redirect (see src/lib/subscription.ts).
 *
 * `opts.mfaEnabled` (gap-audit P1) seeds the owner with MFA already
 * enrolled and enabled, the exact same persisted shape as
 * seedPlatformAdmin uses and for the same reason: requireOwnerMfaEnabled
 * (guard.ts) 403s every sensitive owner-only route — billing upgrade
 * requests, ledger/reconciliation exports, refunds, payroll payments,
 * staff role changes — for an owner without it. Left off (the default)
 * for every spec that doesn't touch one of those routes, so the ordinary
 * single-step login flow most specs use keeps working unchanged.
 */
export async function seedOwnerRestaurant(
  label: string,
  opts?: { mfaEnabled?: boolean },
): Promise<SeededRestaurant> {
  const suffix = randomSuffix();
  const ownerPhone = randomPhone();
  const mfaSecret = opts?.mfaEnabled ? generateSecret() : null;

  const [owner] = await db
    .insert(users)
    .values({
      fullName: `TEST E2E Owner ${label}`,
      phone: ownerPhone,
      passwordHash: await hashPassword(E2E_PASSWORD),
      ...(mfaSecret
        ? { mfaEnabled: true, mfaSecret, mfaEnabledAt: new Date() }
        : {}),
    })
    .returning({ id: users.id });

  const [restaurant] = await db
    .insert(restaurants)
    .values({
      slug: `test-e2e-${label}-${suffix}`,
      name: `TEST E2E ${label} Restaurant`,
    })
    .returning({ id: restaurants.id, slug: restaurants.slug, name: restaurants.name });

  const [branch] = await db
    .insert(branches)
    .values({ restaurantId: restaurant.id, name: "Main", isMain: true })
    .returning({ id: branches.id });

  await db.insert(userRoles).values({
    userId: owner.id,
    restaurantId: restaurant.id,
    role: "owner",
    isActive: true,
  });

  return {
    restaurantId: restaurant.id,
    branchId: branch.id,
    slug: restaurant.slug,
    name: restaurant.name,
    ownerId: owner.id,
    ownerPhone,
    extraUserIds: [],
    mfaSecret,
  };
}

/** Adds a second (non-main) branch to an already-seeded restaurant — used
 * by the branch-cross-access spec to prove a staff member scoped to one
 * branch can't reach another branch's data through the real UI. */
export async function seedBranch(r: SeededRestaurant, name: string): Promise<string> {
  const [branch] = await db
    .insert(branches)
    .values({ restaurantId: r.restaurantId, name })
    .returning({ id: branches.id });
  return branch.id;
}

/**
 * Seeds one staff member with a real bcrypt password hash (so the real
 * /api/auth/login route accepts it, same as seedOwnerRestaurant's owner)
 * and an active role grant — optionally scoped to a specific branch via
 * `branchId` (omit/null for an unrestricted, all-branches grant, matching
 * how the "Add staff" form's own "All branches" option works). The new
 * user's id is pushed onto `r.extraUserIds` so teardownRestaurant deletes
 * it along with everything else this restaurant's tests created.
 */
export async function seedStaffMember(
  r: SeededRestaurant,
  opts: { role: AssignableStaffRole; branchId?: string | null; fullName?: string },
): Promise<{ userId: string; phone: string; userRoleId: string }> {
  const phone = randomPhone();
  const [user] = await db
    .insert(users)
    .values({
      fullName: opts.fullName ?? `TEST E2E Staff (${opts.role})`,
      phone,
      passwordHash: await hashPassword(E2E_PASSWORD),
    })
    .returning({ id: users.id });

  const [roleRow] = await db
    .insert(userRoles)
    .values({
      userId: user.id,
      restaurantId: r.restaurantId,
      branchId: opts.branchId ?? null,
      role: opts.role,
      isActive: true,
    })
    .returning({ id: userRoles.id });

  r.extraUserIds.push(user.id);

  return { userId: user.id, phone, userRoleId: roleRow.id };
}

/**
 * Creates one inventory item plus a recipe line linking it to `menuItemId`
 * — the exact chain deductRecipeStockForOrder (src/lib/inventory.ts) walks
 * when an order transitions confirmed -> preparing. `initialStockMilliunits`
 * and `quantityPerServingMilliunits` are both in the item's own unit,
 * milliunits (real quantity * 1000 — see src/lib/quantity.ts's doc
 * comment), matching every other stock-quantity column in this schema.
 */
export async function seedInventoryItemWithRecipe(
  r: SeededRestaurant,
  opts: {
    menuItemId: string;
    name: string;
    unit: InventoryUnit;
    initialStockMilliunits: number;
    quantityPerServingMilliunits: number;
  },
): Promise<{ inventoryItemId: string }> {
  const [item] = await db
    .insert(inventoryItems)
    .values({
      restaurantId: r.restaurantId,
      name: opts.name,
      unit: opts.unit,
      currentStockMilliunits: opts.initialStockMilliunits,
    })
    .returning({ id: inventoryItems.id });

  await db.insert(recipeItems).values({
    restaurantId: r.restaurantId,
    menuItemId: opts.menuItemId,
    inventoryItemId: item.id,
    quantityPerServingMilliunits: opts.quantityPerServingMilliunits,
  });

  return { inventoryItemId: item.id };
}

/** Adds one active category + one orderable (no variants/addons — the
 * public order page doesn't require either) menu item, and one active
 * table with a real qrToken, to a restaurant already seeded via
 * seedOwnerRestaurant. Returns the qrToken the /order/[token] page uses. */
export async function seedMenuAndTable(
  r: SeededRestaurant,
  opts?: { branchId?: string },
): Promise<{ qrToken: string; tableName: string; menuItemId: string }> {
  const [category] = await db
    .insert(categories)
    .values({ restaurantId: r.restaurantId, name: "TEST Mains" })
    .returning({ id: categories.id });

  const [menuItem] = await db
    .insert(menuItems)
    .values({
      restaurantId: r.restaurantId,
      categoryId: category.id,
      name: "TEST Momo",
      basePriceInPaisa: 25000, // Rs. 250.00
    })
    .returning({ id: menuItems.id });

  const qrToken = `test-qr-${randomSuffix()}-${randomSuffix()}`;
  const tableName = "TEST Table 1";
  // opts?.branchId lets a spec put the table (and therefore every order
  // placed at it — see /api/order/[token]'s route, which copies the
  // table's branchId onto the order) at a specific, non-main branch — the
  // branch-cross-access spec's whole reason for existing.
  await db.insert(restaurantTables).values({
    restaurantId: r.restaurantId,
    branchId: opts?.branchId ?? r.branchId,
    name: tableName,
    capacity: 4,
    qrToken,
  });

  return { qrToken, tableName, menuItemId: menuItem.id };
}

export type SeededPlatformAdmin = {
  userId: string;
  phone: string;
  /**
   * Base32 TOTP secret for this admin, generated with otplib's own
   * generateSecret() — the exact same call mfa.ts's generateMfaEnrollment
   * makes (see this file's import comment for why that helper itself
   * can't be imported here) — a spec logging in as this admin computes a live
   * 6-digit code from this with otplib's `generate()` (see e2e/db.ts's own
   * import and src/db/__tests__/mfa.test.ts's identical pattern), exactly
   * like a real authenticator app would, rather than special-casing MFA
   * away for the test.
   */
  mfaSecret: string;
};

/**
 * Seeds one platform_admin user — a real user_roles row with
 * restaurantId: null (a platform-scoped grant, not tied to any one
 * tenant — see schema.ts's own comment on user_roles_one_active_per_
 * restaurant_unique excluding these rows) — with MFA already enrolled and
 * enabled.
 *
 * requirePlatformAdmin()/requirePlatformPermission() (src/lib/rbac/guard.ts)
 * hard-require users.mfaEnabled = true before any platform route (including
 * /api/admin/impersonation/start) will do anything, so a seeded platform
 * admin without MFA enabled would 403 on every single platform action —
 * this mirrors confirmMfaEnrollment's own persisted shape (mfaEnabled: true,
 * mfaSecret set, mfaEnabledAt set) directly via a DB insert rather than
 * driving the actual /api/auth/mfa/enroll/confirm HTTP round trip, the same
 * "seed the end state directly" convention seedOwnerRestaurant already uses
 * for passwordHash instead of going through /api/auth/register. The secret
 * itself is realistic, not a shortcut: it's produced by the exact same
 * otplib generateSecret() call the real enrollment endpoint's
 * generateMfaEnrollment() wraps, stored exactly as plaintext base32 the way
 * schema.ts's own comment documents mfaSecret
 * being stored (this app has no column-level encryption for it — "anyone
 * with DB access already has everything" is the documented trust boundary),
 * so the seeded row is byte-for-byte what a real enrolled account looks
 * like in this DB, and the spec still has to submit a real, freshly
 * computed TOTP code through the real /login + /api/auth/mfa/verify flow
 * to get in.
 */
export async function seedPlatformAdmin(label: string): Promise<SeededPlatformAdmin> {
  const phone = randomPhone();
  const secret = generateSecret();

  const [admin] = await db
    .insert(users)
    .values({
      fullName: `TEST E2E Platform Admin ${label}`,
      phone,
      passwordHash: await hashPassword(E2E_PASSWORD),
      mfaEnabled: true,
      mfaSecret: secret,
      mfaEnabledAt: new Date(),
    })
    .returning({ id: users.id });

  await db.insert(userRoles).values({
    userId: admin.id,
    restaurantId: null,
    role: "platform_admin",
    isActive: true,
  });

  return { userId: admin.id, phone, mfaSecret: secret };
}

/** Deletes a platform admin seeded via seedPlatformAdmin — any
 * platform_impersonation_sessions row this admin started (FK-referenced by
 * both admin_user_id and, once exited, ended_by_user_id — neither is
 * ON DELETE CASCADE, so a spec that actually starts/exits impersonation
 * would otherwise leave the users row un-deletable), its userRoles row
 * (restaurantId IS NULL, so teardownRestaurant never touches it), and the
 * user row itself. */
export async function teardownPlatformAdmin(admin: SeededPlatformAdmin): Promise<void> {
  await db
    .delete(platformImpersonationSessions)
    .where(eq(platformImpersonationSessions.adminUserId, admin.userId));
  await db.delete(userRoles).where(eq(userRoles.userId, admin.userId));
  await db.delete(users).where(eq(users.id, admin.userId));
}

/** Deletes everything a spec may have created for one seeded restaurant,
 * in FK-safe order (children before parents) — mirrors the afterAll blocks
 * in src/db/__tests__/. Safe to call even if some tables were never
 * populated (DELETE ... WHERE matching nothing is a no-op). */
export async function teardownRestaurant(r: SeededRestaurant): Promise<void> {
  // order_items has no restaurantId of its own — ON DELETE CASCADE from
  // orders.id takes care of it when the orders row below is deleted.
  // stock_movements/branch_inventory_levels similarly cascade from the
  // inventory_items row they reference, so they need no explicit delete
  // here either.
  await db.delete(orders).where(eq(orders.restaurantId, r.restaurantId));
  await db.delete(reservations).where(eq(reservations.restaurantId, r.restaurantId));
  await db.delete(restaurantTables).where(eq(restaurantTables.restaurantId, r.restaurantId));
  // recipe_items.inventory_item_id is ON DELETE RESTRICT (see schema.ts),
  // so it must go before inventory_items; recipe_items.menu_item_id is
  // itself ON DELETE CASCADE from menu_items, but deleting it explicitly
  // first keeps this ordering simple to reason about either way.
  await db.delete(recipeItems).where(eq(recipeItems.restaurantId, r.restaurantId));
  await db.delete(inventoryItems).where(eq(inventoryItems.restaurantId, r.restaurantId));
  await db.delete(menuItems).where(eq(menuItems.restaurantId, r.restaurantId));
  await db.delete(categories).where(eq(categories.restaurantId, r.restaurantId));
  // payroll_payments.user_role_id is ON DELETE RESTRICT (a payout receipt
  // must survive a staff deactivation in real usage — see schema.ts), so
  // it has to go before user_roles below; staff_salary_configs cascades
  // from user_roles on its own but is deleted explicitly too for clarity.
  await db.delete(payrollPayments).where(eq(payrollPayments.restaurantId, r.restaurantId));
  await db.delete(staffSalaryConfigs).where(eq(staffSalaryConfigs.restaurantId, r.restaurantId));
  await db.delete(userRoles).where(eq(userRoles.restaurantId, r.restaurantId));
  await db.delete(branches).where(eq(branches.restaurantId, r.restaurantId));
  await db.delete(restaurants).where(eq(restaurants.id, r.restaurantId));
  await db.delete(users).where(eq(users.id, r.ownerId));
  for (const userId of r.extraUserIds) {
    // sessions cascade from users.id (ON DELETE CASCADE), so no separate
    // sessions cleanup is needed even for the expired-session spec, which
    // writes directly into this table.
    await db.delete(users).where(eq(users.id, userId));
  }
}

/**
 * Cleans up a restaurant created through the REAL registration + onboarding
 * UI (owner-onboarding.spec.ts) rather than seedOwnerRestaurant — there's
 * no SeededRestaurant object to hand back in that flow (the spec never
 * calls the DB directly to create anything), so this looks the owner and
 * their restaurant(s) up by phone number after the fact and reuses the
 * exact same teardown logic above.
 */
export async function teardownByOwnerPhone(phone: string): Promise<void> {
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).limit(1);
  if (!owner) return; // registration never actually completed — nothing to clean up

  const roleRows = await db
    .select({ restaurantId: userRoles.restaurantId })
    .from(userRoles)
    .where(eq(userRoles.userId, owner.id));

  for (const row of roleRows) {
    if (!row.restaurantId) continue;
    await teardownRestaurant({
      restaurantId: row.restaurantId,
      branchId: "", // unused by teardownRestaurant itself
      slug: "",
      name: "",
      ownerId: owner.id,
      ownerPhone: phone,
      extraUserIds: [],
      mfaSecret: null,
    });
  }

  // Unconditional and safe either way: teardownRestaurant above already
  // deleted this user row for every restaurant found via userRoles, so
  // this is a no-op delete in that case — but if the test failed between
  // registration and onboarding (no restaurant ever created, roleRows
  // empty), this is the only thing that cleans up the orphaned user row.
  await db.delete(users).where(eq(users.id, owner.id));
}

/** Looks up a session row's expiry directly — used by the expired-session
 * spec to flip a real, freshly-issued session into the past, the same
 * "manually expiring a session row" scenario named in the gap audit,
 * without needing to know the session's raw (only-ever-hashed) token. */
export async function expireSessionForUser(userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(sessions.userId, userId));
}
