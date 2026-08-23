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
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";

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
  ownerId: string;
  ownerPhone: string;
};

/**
 * Seeds one restaurant + main branch + an owner user with an active
 * "owner" role grant and a real bcrypt password hash (so the real
 * /api/auth/login route accepts it). subscriptionStatus/trialEndsAt are
 * left at their column defaults ("trialing" / null) — computeSubscriptionAccess
 * treats a null trialEndsAt as "trial never expires", so this doesn't
 * trip the dashboard layout's billing redirect (see src/lib/subscription.ts).
 */
export async function seedOwnerRestaurant(label: string): Promise<SeededRestaurant> {
  const suffix = randomSuffix();
  const ownerPhone = randomPhone();

  const [owner] = await db
    .insert(users)
    .values({
      fullName: `TEST E2E Owner ${label}`,
      phone: ownerPhone,
      passwordHash: await hashPassword(E2E_PASSWORD),
    })
    .returning({ id: users.id });

  const [restaurant] = await db
    .insert(restaurants)
    .values({
      slug: `test-e2e-${label}-${suffix}`,
      name: `TEST E2E ${label} Restaurant`,
    })
    .returning({ id: restaurants.id, slug: restaurants.slug });

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
    ownerId: owner.id,
    ownerPhone,
  };
}

/** Adds one active category + one orderable (no variants/addons — the
 * public order page doesn't require either) menu item, and one active
 * table with a real qrToken, to a restaurant already seeded via
 * seedOwnerRestaurant. Returns the qrToken the /order/[token] page uses. */
export async function seedMenuAndTable(r: SeededRestaurant): Promise<{ qrToken: string; tableName: string }> {
  const [category] = await db
    .insert(categories)
    .values({ restaurantId: r.restaurantId, name: "TEST Mains" })
    .returning({ id: categories.id });

  await db.insert(menuItems).values({
    restaurantId: r.restaurantId,
    categoryId: category.id,
    name: "TEST Momo",
    basePriceInPaisa: 25000, // Rs. 250.00
  });

  const qrToken = `test-qr-${randomSuffix()}-${randomSuffix()}`;
  const tableName = "TEST Table 1";
  await db.insert(restaurantTables).values({
    restaurantId: r.restaurantId,
    branchId: r.branchId,
    name: tableName,
    capacity: 4,
    qrToken,
  });

  return { qrToken, tableName };
}

/** Deletes everything a spec may have created for one seeded restaurant,
 * in FK-safe order (children before parents) — mirrors the afterAll blocks
 * in src/db/__tests__/. Safe to call even if some tables were never
 * populated (DELETE ... WHERE matching nothing is a no-op). */
export async function teardownRestaurant(r: SeededRestaurant): Promise<void> {
  // order_items has no restaurantId of its own — ON DELETE CASCADE from
  // orders.id takes care of it when the orders row below is deleted.
  await db.delete(orders).where(eq(orders.restaurantId, r.restaurantId));
  await db.delete(reservations).where(eq(reservations.restaurantId, r.restaurantId));
  await db.delete(restaurantTables).where(eq(restaurantTables.restaurantId, r.restaurantId));
  await db.delete(menuItems).where(eq(menuItems.restaurantId, r.restaurantId));
  await db.delete(categories).where(eq(categories.restaurantId, r.restaurantId));
  await db.delete(userRoles).where(eq(userRoles.restaurantId, r.restaurantId));
  await db.delete(branches).where(eq(branches.restaurantId, r.restaurantId));
  await db.delete(restaurants).where(eq(restaurants.id, r.restaurantId));
  await db.delete(users).where(eq(users.id, r.ownerId));
}
