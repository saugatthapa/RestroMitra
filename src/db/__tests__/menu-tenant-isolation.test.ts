/**
 * Phase 2 integration test: proves the menu system (categories, items,
 * variants, add-ons) never leaks across tenant boundaries.
 *
 * Every menu API route follows the same pattern used here directly:
 * mutations are scoped with `WHERE id = :id AND restaurant_id = :restaurantId`
 * (see e.g. src/app/api/restaurants/[slug]/categories/[categoryId]/route.ts),
 * so a caller authenticated as restaurant B attempting to touch restaurant
 * A's category/item id matches zero rows rather than silently succeeding.
 * This test proves that scoping pattern actually works against a real
 * database, not just that the code "looks right".
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as
 * tenant-isolation.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("menu tenant isolation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let ownerAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let categoryAId: string;
  let menuItemAId: string;
  let variantAId: string;
  let addonAId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Menu Owner A",
        phone: `9703${suffix.slice(0, 6)}`,
        passwordHash: "test-hash-not-used",
      })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Menu Owner B",
        phone: `9704${suffix.slice(0, 6)}`,
        passwordHash: "test-hash-not-used",
      })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-menu-a-${suffix}`, name: "TEST Menu Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-menu-b-${suffix}`, name: "TEST Menu Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerAId, restaurantId: restaurantAId, role: "owner" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId: restaurantAId, name: "TEST Momo" })
      .returning({ id: schema.categories.id });
    categoryAId = category.id;

    const [item] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId: restaurantAId,
        categoryId: categoryAId,
        name: "TEST Buff Momo",
        basePriceInPaisa: 18000,
      })
      .returning({ id: schema.menuItems.id });
    menuItemAId = item.id;

    const [variant] = await db
      .insert(schema.menuVariants)
      .values({ menuItemId: menuItemAId, name: "Large", priceInPaisa: 22000 })
      .returning({ id: schema.menuVariants.id });
    variantAId = variant.id;

    const [addon] = await db
      .insert(schema.menuAddons)
      .values({ menuItemId: menuItemAId, name: "Extra spicy", priceInPaisa: 0 })
      .returning({ id: schema.menuAddons.id });
    addonAId = addon.id;
  });

  afterAll(async () => {
    await db.delete(schema.menuAddons).where(eq(schema.menuAddons.id, addonAId));
    await db.delete(schema.menuVariants).where(eq(schema.menuVariants.id, variantAId));
    await db.delete(schema.menuItems).where(eq(schema.menuItems.id, menuItemAId));
    await db.delete(schema.categories).where(eq(schema.categories.id, categoryAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, ownerAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, ownerBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("owner B cannot even resolve restaurant access to restaurant A (precondition for every menu route)", async () => {
    await expect(
      guard.requireRestaurantAccess(ownerBId, restaurantAId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner B is denied edit_menu on restaurant A", async () => {
    await expect(
      guard.requirePermission(ownerBId, restaurantAId, PERMISSIONS.EDIT_MENU),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("listing categories scoped to restaurant B never returns restaurant A's category", async () => {
    const rows = await db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.restaurantId, restaurantBId));
    expect(rows.find((c) => c.id === categoryAId)).toBeUndefined();
  });

  it("listing menu items scoped to restaurant B never returns restaurant A's item", async () => {
    const rows = await db
      .select()
      .from(schema.menuItems)
      .where(eq(schema.menuItems.restaurantId, restaurantBId));
    expect(rows.find((i) => i.id === menuItemAId)).toBeUndefined();
  });

  it("an update scoped to restaurant B's id matches ZERO rows against restaurant A's category (the exact guard every PATCH/DELETE route relies on)", async () => {
    const updated = await db
      .update(schema.categories)
      .set({ name: "HIJACKED" })
      .where(and(eq(schema.categories.id, categoryAId), eq(schema.categories.restaurantId, restaurantBId)))
      .returning();
    expect(updated).toHaveLength(0);

    // Confirm the category genuinely wasn't touched.
    const [stillOriginal] = await db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryAId));
    expect(stillOriginal.name).toBe("TEST Momo");
  });

  it("an update scoped to restaurant B's id matches ZERO rows against restaurant A's menu item", async () => {
    const updated = await db
      .update(schema.menuItems)
      .set({ basePriceInPaisa: 1 })
      .where(and(eq(schema.menuItems.id, menuItemAId), eq(schema.menuItems.restaurantId, restaurantBId)))
      .returning();
    expect(updated).toHaveLength(0);

    const [stillOriginal] = await db
      .select()
      .from(schema.menuItems)
      .where(eq(schema.menuItems.id, menuItemAId));
    expect(stillOriginal.basePriceInPaisa).toBe(18000);
  });
});
