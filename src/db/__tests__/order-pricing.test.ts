/**
 * Phase 3 integration test: proves computeOrderPricing() (src/lib/orders.ts)
 * — the single choke point the public, unauthenticated /api/order/[token]
 * route relies on — always derives price/tax from the current menu rows in
 * the database, never from anything a caller passes in. CartItemInput has
 * no price field at all, so there's nothing for a malicious client to even
 * submit; these tests instead cover the boundary conditions that function
 * has to get right: variant-required items, unavailable/inactive items,
 * addon lookups, quantity limits, and tax computed per line.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("computeOrderPricing (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let orders: typeof import("@/lib/orders");

  let restaurantId: string;
  let otherRestaurantId: string;
  let categoryId: string;
  // Simple item: no variants, 13% tax, one addon.
  let simpleItemId: string;
  let addonId: string;
  // Variant item: two sizes, 0% tax.
  let variantItemId: string;
  let smallVariantId: string;
  let largeVariantId: string;
  // Inactive / unavailable items, and an item that belongs to ANOTHER
  // restaurant entirely (proves the query is actually scoped, not just
  // filtered client-side).
  let inactiveItemId: string;
  let unavailableItemId: string;
  let otherRestaurantItemId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    orders = await import("@/lib/orders");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-pricing-${suffix}`, name: "TEST Pricing Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-pricing-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId, name: "TEST Category" })
      .returning({ id: schema.categories.id });
    categoryId = category.id;

    const [otherCategory] = await db
      .insert(schema.categories)
      .values({ restaurantId: otherRestaurantId, name: "TEST Other Category" })
      .returning({ id: schema.categories.id });

    const [simpleItem] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId,
        categoryId,
        name: "TEST Simple Item",
        basePriceInPaisa: 10_000, // Rs. 100
        taxRateBasisPoints: 1300, // 13%
      })
      .returning({ id: schema.menuItems.id });
    simpleItemId = simpleItem.id;

    const [addon] = await db
      .insert(schema.menuAddons)
      .values({ menuItemId: simpleItemId, name: "TEST Extra Spicy", priceInPaisa: 2_000 })
      .returning({ id: schema.menuAddons.id });
    addonId = addon.id;

    const [variantItem] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId,
        categoryId,
        name: "TEST Variant Item",
        basePriceInPaisa: 0,
        taxRateBasisPoints: 0,
      })
      .returning({ id: schema.menuItems.id });
    variantItemId = variantItem.id;

    const [small] = await db
      .insert(schema.menuVariants)
      .values({ menuItemId: variantItemId, name: "Small", priceInPaisa: 15_000 })
      .returning({ id: schema.menuVariants.id });
    smallVariantId = small.id;
    const [large] = await db
      .insert(schema.menuVariants)
      .values({ menuItemId: variantItemId, name: "Large", priceInPaisa: 20_000 })
      .returning({ id: schema.menuVariants.id });
    largeVariantId = large.id;

    const [inactiveItem] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId,
        categoryId,
        name: "TEST Inactive Item",
        basePriceInPaisa: 5_000,
        isActive: false,
      })
      .returning({ id: schema.menuItems.id });
    inactiveItemId = inactiveItem.id;

    const [unavailableItem] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId,
        categoryId,
        name: "TEST Unavailable Item",
        basePriceInPaisa: 5_000,
        isAvailable: false,
      })
      .returning({ id: schema.menuItems.id });
    unavailableItemId = unavailableItem.id;

    const [otherItem] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId: otherRestaurantId,
        categoryId: otherCategory.id,
        name: "TEST Other Restaurant Item",
        basePriceInPaisa: 1, // suspiciously cheap — proves it's never used
      })
      .returning({ id: schema.menuItems.id });
    otherRestaurantItemId = otherItem.id;
  });

  afterAll(async () => {
    await db.delete(schema.menuItems).where(eq(schema.menuItems.restaurantId, restaurantId));
    await db
      .delete(schema.menuItems)
      .where(eq(schema.menuItems.restaurantId, otherRestaurantId));
    await db.delete(schema.categories).where(eq(schema.categories.restaurantId, restaurantId));
    await db
      .delete(schema.categories)
      .where(eq(schema.categories.restaurantId, otherRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  it("computes subtotal/tax/total for a simple item with no addons", async () => {
    const result = await orders.computeOrderPricing(restaurantId, [
      { menuItemId: simpleItemId, quantity: 2 },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].unitPriceInPaisa).toBe(10_000);
    expect(result.items[0].lineSubtotalInPaisa).toBe(20_000);
    expect(result.items[0].addonsTotalInPaisa).toBe(0);
    expect(result.items[0].lineTotalInPaisa).toBe(20_000);
    expect(result.subtotalInPaisa).toBe(20_000);
    expect(result.taxInPaisa).toBe(2_600); // 13% of 20000
    expect(result.totalInPaisa).toBe(22_600);
  });

  it("includes addon price (per unit, multiplied by quantity) in the line and tax", async () => {
    const result = await orders.computeOrderPricing(restaurantId, [
      { menuItemId: simpleItemId, quantity: 3, addons: [{ addonId }] },
    ]);
    const line = result.items[0];
    expect(line.addonsTotalInPaisa).toBe(6_000); // 2000 * 3
    expect(line.lineTotalInPaisa).toBe(36_000); // (10000+2000) * 3
    expect(result.taxInPaisa).toBe(4_680); // 13% of 36000
  });

  it("uses the selected variant's price, not the item's base price", async () => {
    const result = await orders.computeOrderPricing(restaurantId, [
      { menuItemId: variantItemId, variantId: largeVariantId, quantity: 1 },
    ]);
    expect(result.items[0].unitPriceInPaisa).toBe(20_000);
    expect(result.items[0].variantNameSnapshot).toBe("Large");
    expect(result.taxInPaisa).toBe(0);
  });

  it("rejects a variant-having item ordered without a variantId", async () => {
    await expect(
      orders.computeOrderPricing(restaurantId, [{ menuItemId: variantItemId, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a variantId that doesn't belong to the item", async () => {
    await expect(
      orders.computeOrderPricing(restaurantId, [
        { menuItemId: simpleItemId, variantId: smallVariantId, quantity: 1 },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an inactive item", async () => {
    await expect(
      orders.computeOrderPricing(restaurantId, [{ menuItemId: inactiveItemId, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unavailable (out of stock) item", async () => {
    await expect(
      orders.computeOrderPricing(restaurantId, [{ menuItemId: unavailableItemId, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an item that belongs to a different restaurant, even with a valid-looking id", async () => {
    await expect(
      orders.computeOrderPricing(restaurantId, [
        { menuItemId: otherRestaurantItemId, quantity: 1 },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unknown addonId", async () => {
    await expect(
      orders.computeOrderPricing(restaurantId, [
        { menuItemId: simpleItemId, quantity: 1, addons: [{ addonId: largeVariantId }] },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects quantity 0 and quantity over 50", async () => {
    await expect(
      orders.computeOrderPricing(restaurantId, [{ menuItemId: simpleItemId, quantity: 0 }]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      orders.computeOrderPricing(restaurantId, [{ menuItemId: simpleItemId, quantity: 51 }]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an empty cart", async () => {
    await expect(orders.computeOrderPricing(restaurantId, [])).rejects.toMatchObject({
      status: 400,
    });
  });

  it("generateOrderNumber produces a YYYYMMDD-XXXX shaped, non-colliding-in-practice number", () => {
    const a = orders.generateOrderNumber("UTC");
    const b = orders.generateOrderNumber("UTC");
    expect(a).toMatch(/^\d{8}-[0-9A-F]{4}$/);
    expect(b).toMatch(/^\d{8}-[0-9A-F]{4}$/);
    // Not a strict uniqueness guarantee (that's the DB unique index's job —
    // see the retry loop in api/order/[token]/route.ts), just confirms two
    // consecutive calls aren't trivially identical.
    expect(a).not.toBe(b);
  });

  it("sums subtotal/tax across multiple distinct line items", async () => {
    const result = await orders.computeOrderPricing(restaurantId, [
      { menuItemId: simpleItemId, quantity: 1 }, // 10000, tax 1300
      { menuItemId: variantItemId, variantId: smallVariantId, quantity: 1 }, // 15000, tax 0
    ]);
    expect(result.subtotalInPaisa).toBe(25_000);
    expect(result.taxInPaisa).toBe(1_300);
    expect(result.totalInPaisa).toBe(26_300);
  });
});
