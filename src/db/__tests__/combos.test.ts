/**
 * Commercial Launch Phase B.8 (Combos) integration tests for
 * computeComboPricing/assertComboItemsOwnership in src/lib/combos.ts.
 *
 * Same convention as order-pricing.test.ts/coupons.test.ts (see their own
 * doc comments): exercises the business logic directly — proportional
 * price allocation (and that it always sums back to EXACTLY the bundle
 * price, the one invariant this whole feature exists to guarantee),
 * eligibility rejection, and tenant isolation.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Combos (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let combos: typeof import("@/lib/combos");

  let restaurantId: string;
  let otherRestaurantId: string;
  let categoryId: string;
  let otherCategoryId: string;
  // Momo: Rs. 150, 13% tax. Coke: Rs. 60, 0% tax. A "2 Momo + 1 Coke" combo
  // priced at Rs. 300 (cheaper than 2*150 + 60 = 360 bought separately).
  let momoId: string;
  let cokeId: string;
  let comboId: string;
  let inactiveItemId: string;
  let unavailableItemId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    combos = await import("@/lib/combos");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-combos-${suffix}`, name: "TEST Combos Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-combos-other-${suffix}`, name: "TEST Other Restaurant" })
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
    otherCategoryId = otherCategory.id;

    const [momo] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST Momo", basePriceInPaisa: 15_000, taxRateBasisPoints: 1300 })
      .returning({ id: schema.menuItems.id });
    momoId = momo.id;

    const [coke] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST Coke", basePriceInPaisa: 6_000, taxRateBasisPoints: 0 })
      .returning({ id: schema.menuItems.id });
    cokeId = coke.id;

    const [inactiveItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST Inactive", basePriceInPaisa: 5_000, isActive: false })
      .returning({ id: schema.menuItems.id });
    inactiveItemId = inactiveItem.id;

    const [unavailableItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST Unavailable", basePriceInPaisa: 5_000, isAvailable: false })
      .returning({ id: schema.menuItems.id });
    unavailableItemId = unavailableItem.id;

    const [combo] = await db
      .insert(schema.menuCombos)
      .values({ restaurantId, name: "TEST Momo Combo", priceInPaisa: 30_000 }) // Rs. 300
      .returning({ id: schema.menuCombos.id });
    comboId = combo.id;
    await db.insert(schema.menuComboItems).values([
      { comboId, menuItemId: momoId, quantity: 2 },
      { comboId, menuItemId: cokeId, quantity: 1 },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.menuComboItems).where(eq(schema.menuComboItems.comboId, comboId));
    await db.delete(schema.menuCombos).where(eq(schema.menuCombos.restaurantId, restaurantId));
    await db.delete(schema.menuItems).where(eq(schema.menuItems.restaurantId, restaurantId));
    await db.delete(schema.menuItems).where(eq(schema.menuItems.restaurantId, otherRestaurantId));
    await db.delete(schema.categories).where(eq(schema.categories.restaurantId, restaurantId));
    await db.delete(schema.categories).where(eq(schema.categories.restaurantId, otherRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  it("happy path: explodes one bundle into its component items, allocated proportionally and summing to the exact bundle price", async () => {
    const result = await combos.computeComboPricing(restaurantId, [{ comboId, quantity: 1 }]);
    expect(result.items).toHaveLength(2);
    expect(result.subtotalInPaisa).toBe(30_000); // exactly the bundle price, never off by rounding

    const momoLine = result.items.find((i) => i.menuItemId === momoId)!;
    const cokeLine = result.items.find((i) => i.menuItemId === cokeId)!;
    expect(momoLine.quantity).toBe(2);
    expect(cokeLine.quantity).toBe(1);
    // Weight: momo = 15000*2 = 30000, coke = 6000*1 = 6000, sum = 36000.
    // Momo's share: floor(30000 * 30000/36000) = 25000; coke gets the
    // remainder: 30000 - 25000 = 5000.
    expect(momoLine.lineTotalInPaisa).toBe(25_000);
    expect(cokeLine.lineTotalInPaisa).toBe(5_000);
    expect(momoLine.lineTotalInPaisa + cokeLine.lineTotalInPaisa).toBe(30_000);
  });

  it("happy path: tax is computed per component at ITS OWN rate on the allocated (bundle) amount, not the normal price", async () => {
    const result = await combos.computeComboPricing(restaurantId, [{ comboId, quantity: 1 }]);
    const momoLine = result.items.find((i) => i.menuItemId === momoId)!;
    // 13% of momo's allocated 25,000 = 3,250. Coke is 0% tax, contributes 0.
    expect(result.taxInPaisa).toBe(3_250);
    expect(momoLine.lineTotalInPaisa).toBe(25_000);
  });

  it("edge case: N bundles scale the per-bundle allocation exactly — subtotal is always bundlePrice * N, never drifted by rounding", async () => {
    const result = await combos.computeComboPricing(restaurantId, [{ comboId, quantity: 5 }]);
    expect(result.subtotalInPaisa).toBe(30_000 * 5);
    const momoLine = result.items.find((i) => i.menuItemId === momoId)!;
    const cokeLine = result.items.find((i) => i.menuItemId === cokeId)!;
    expect(momoLine.quantity).toBe(2 * 5);
    expect(cokeLine.quantity).toBe(1 * 5);
    expect(momoLine.lineTotalInPaisa + cokeLine.lineTotalInPaisa).toBe(30_000 * 5);
  });

  it("edge case: every exploded row from one combo cart line shares the same comboGroupId and comboNameSnapshot", async () => {
    const result = await combos.computeComboPricing(restaurantId, [{ comboId, quantity: 1 }]);
    const groupIds = new Set(result.items.map((i) => i.comboGroupId));
    expect(groupIds.size).toBe(1);
    expect(result.items.every((i) => i.comboNameSnapshot === "TEST Momo Combo")).toBe(true);
  });

  it("edge case: two separate combo cart lines (even for the same combo) get DIFFERENT comboGroupIds", async () => {
    const result = await combos.computeComboPricing(restaurantId, [
      { comboId, quantity: 1 },
      { comboId, quantity: 1 },
    ]);
    const groupIds = new Set(result.items.map((i) => i.comboGroupId));
    expect(groupIds.size).toBe(2);
  });

  it("edge case: an empty combo line list returns a zeroed, empty result", async () => {
    const result = await combos.computeComboPricing(restaurantId, []);
    expect(result.items).toHaveLength(0);
    expect(result.subtotalInPaisa).toBe(0);
    expect(result.taxInPaisa).toBe(0);
  });

  it("validation failure: an unknown comboId is rejected", async () => {
    await expect(
      combos.computeComboPricing(restaurantId, [{ comboId: "00000000-0000-0000-0000-000000000001", quantity: 1 }]),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("validation failure: an inactive combo is rejected", async () => {
    const [inactiveCombo] = await db
      .insert(schema.menuCombos)
      .values({ restaurantId, name: "TEST Inactive Combo", priceInPaisa: 10_000, isActive: false })
      .returning({ id: schema.menuCombos.id });
    await db.insert(schema.menuComboItems).values({ comboId: inactiveCombo.id, menuItemId: momoId, quantity: 1 });

    await expect(
      combos.computeComboPricing(restaurantId, [{ comboId: inactiveCombo.id, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("validation failure: a combo whose component item is now inactive/unavailable is rejected", async () => {
    const [brokenCombo] = await db
      .insert(schema.menuCombos)
      .values({ restaurantId, name: "TEST Broken Combo", priceInPaisa: 10_000 })
      .returning({ id: schema.menuCombos.id });
    await db.insert(schema.menuComboItems).values({ comboId: brokenCombo.id, menuItemId: inactiveItemId, quantity: 1 });

    await expect(
      combos.computeComboPricing(restaurantId, [{ comboId: brokenCombo.id, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 400 });

    const [brokenCombo2] = await db
      .insert(schema.menuCombos)
      .values({ restaurantId, name: "TEST Broken Combo 2", priceInPaisa: 10_000 })
      .returning({ id: schema.menuCombos.id });
    await db
      .insert(schema.menuComboItems)
      .values({ comboId: brokenCombo2.id, menuItemId: unavailableItemId, quantity: 1 });

    await expect(
      combos.computeComboPricing(restaurantId, [{ comboId: brokenCombo2.id, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validation failure: a combo with no items configured is rejected", async () => {
    const [emptyCombo] = await db
      .insert(schema.menuCombos)
      .values({ restaurantId, name: "TEST Empty Combo", priceInPaisa: 10_000 })
      .returning({ id: schema.menuCombos.id });

    await expect(
      combos.computeComboPricing(restaurantId, [{ comboId: emptyCombo.id, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validation failure: combo quantity outside [1, 50] is rejected", async () => {
    await expect(combos.computeComboPricing(restaurantId, [{ comboId, quantity: 0 }])).rejects.toMatchObject({
      status: 400,
    });
    await expect(combos.computeComboPricing(restaurantId, [{ comboId, quantity: 51 }])).rejects.toMatchObject({
      status: 400,
    });
  });

  it("wrong-restaurant isolation: a combo belonging to another restaurant is never resolvable", async () => {
    const [foreignCombo] = await db
      .insert(schema.menuCombos)
      .values({ restaurantId: otherRestaurantId, name: "TEST Foreign Combo", priceInPaisa: 10_000 })
      .returning({ id: schema.menuCombos.id });

    await expect(
      combos.computeComboPricing(restaurantId, [{ comboId: foreignCombo.id, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 404 });
  });

  // -----------------------------------------------------------------
  // assertComboItemsOwnership
  // -----------------------------------------------------------------

  it("assertComboItemsOwnership happy path: accepts items that genuinely belong to the restaurant", async () => {
    await expect(
      combos.assertComboItemsOwnership(restaurantId, [{ menuItemId: momoId }, { menuItemId: cokeId }]),
    ).resolves.toBeUndefined();
  });

  it("assertComboItemsOwnership wrong-restaurant isolation: rejects a menu item from another restaurant", async () => {
    const [foreignItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId: otherRestaurantId, categoryId: otherCategoryId, name: "TEST Foreign Item", basePriceInPaisa: 1_000 })
      .returning({ id: schema.menuItems.id });

    await expect(
      combos.assertComboItemsOwnership(restaurantId, [{ menuItemId: foreignItem.id }]),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("assertComboItemsOwnership validation failure: rejects a variant that doesn't belong to the given menu item", async () => {
    const [momoVariant] = await db
      .insert(schema.menuVariants)
      .values({ menuItemId: momoId, name: "TEST Momo Size", priceInPaisa: 15_000 })
      .returning({ id: schema.menuVariants.id });

    // Correct pairing succeeds.
    await expect(
      combos.assertComboItemsOwnership(restaurantId, [{ menuItemId: momoId, variantId: momoVariant.id }]),
    ).resolves.toBeUndefined();

    // Mismatched pairing (momoVariant claimed against cokeId) is rejected.
    await expect(
      combos.assertComboItemsOwnership(restaurantId, [{ menuItemId: cokeId, variantId: momoVariant.id }]),
    ).rejects.toMatchObject({ status: 404 });
  });
});
