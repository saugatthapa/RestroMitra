/**
 * Commercial Launch Phase B.6 (Coupons) integration tests for
 * resolveCoupon/redeemCoupon/unredeemCoupon in src/lib/coupons.ts.
 *
 * Same convention as customer-credit.test.ts/financial-reconciliation.test.ts
 * (see their own doc comments): RBAC/tenant scoping for
 * resolveRestaurantContext() is covered by its own tests, so this file
 * exercises the business logic directly — eligibility rules, the CAS
 * usage-count race, redeem/unredeem symmetry, and tenant isolation.
 *
 * Gap-audit follow-up (P1 revenue leakage) — extended with the four newer
 * restriction types: per-customer usage cap (including its own concurrent
 * -redemption race test, matching the rigor of the pre-existing global
 * -usage-limit race test below), branch restriction, menu-item/category
 * restriction (including the "discount computed on qualifying items only"
 * decision), and first-order-only.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { CouponEligibilityContext } from "@/lib/coupons";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Coupons (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let coupons: typeof import("@/lib/coupons");

  let ownerId: string;
  let restaurantId: string;
  let otherRestaurantId: string;
  let branchId: string;
  let branchId2: string;
  let otherBranchId: string;
  let categoryDrinksId: string;
  let categoryFoodId: string;
  let menuItemDrinkId: string;
  let menuItemFoodId: string;
  let otherMenuItemId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    coupons = await import("@/lib/coupons");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Coupons Owner", phone: `9715${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-coupons-${suffix}`, name: "TEST Coupons Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-coupons-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [branch2] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Second Branch", isMain: false })
      .returning({ id: schema.branches.id });
    branchId2 = branch2.id;

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    otherBranchId = otherBranch.id;

    const [catDrinks] = await db
      .insert(schema.categories)
      .values({ restaurantId, name: "TEST Drinks" })
      .returning({ id: schema.categories.id });
    categoryDrinksId = catDrinks.id;

    const [catFood] = await db
      .insert(schema.categories)
      .values({ restaurantId, name: "TEST Food" })
      .returning({ id: schema.categories.id });
    categoryFoodId = catFood.id;

    const [drink] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId: categoryDrinksId, name: "TEST Cola", basePriceInPaisa: 2_000 })
      .returning({ id: schema.menuItems.id });
    menuItemDrinkId = drink.id;

    const [food] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId: categoryFoodId, name: "TEST Momo", basePriceInPaisa: 8_000 })
      .returning({ id: schema.menuItems.id });
    menuItemFoodId = food.id;

    const [otherItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId: otherRestaurantId, categoryId: catFood.id, name: "TEST Foreign Item", basePriceInPaisa: 1_000 })
      .returning({ id: schema.menuItems.id });
    // Belongs to otherRestaurantId's own category chain — inserted with a
    // category from THIS restaurant above only to satisfy the not-null FK
    // cheaply; never read as "this restaurant's" item in any assertion.
    otherMenuItemId = otherItem.id;
  });

  afterAll(async () => {
    await db.delete(schema.couponCustomerRedemptions).where(eq(schema.couponCustomerRedemptions.restaurantId, restaurantId));
    await db.delete(schema.couponCustomerRedemptions).where(eq(schema.couponCustomerRedemptions.restaurantId, otherRestaurantId));
    await db.delete(schema.couponBranches).where(eq(schema.couponBranches.restaurantId, restaurantId));
    await db.delete(schema.couponMenuItems).where(eq(schema.couponMenuItems.restaurantId, restaurantId));
    await db.delete(schema.couponCategories).where(eq(schema.couponCategories.restaurantId, restaurantId));
    await db.delete(schema.couponRedemptions).where(eq(schema.couponRedemptions.restaurantId, restaurantId));
    await db.delete(schema.couponRedemptions).where(eq(schema.couponRedemptions.restaurantId, otherRestaurantId));
    await db.delete(schema.coupons).where(eq(schema.coupons.restaurantId, restaurantId));
    await db.delete(schema.coupons).where(eq(schema.coupons.restaurantId, otherRestaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, otherRestaurantId));
    await db.delete(schema.customers).where(eq(schema.customers.restaurantId, restaurantId));
    await db.delete(schema.menuItems).where(eq(schema.menuItems.restaurantId, restaurantId));
    await db.delete(schema.menuItems).where(eq(schema.menuItems.restaurantId, otherRestaurantId));
    await db.delete(schema.categories).where(eq(schema.categories.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchId2));
    await db.delete(schema.branches).where(eq(schema.branches.id, otherBranchId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  /** Creates a bare test order to redeem coupons against (couponRedemptions.orderId is NOT NULL). Returns the full row — tests need branchId/customerId/createdAt/id for CouponEligibilityContext. */
  async function makeOrder(
    targetRestaurantId: string,
    targetBranchId: string,
    opts: { subtotalInPaisa?: number; customerId?: string | null; status?: "pending" | "cancelled" } = {},
  ) {
    const { subtotalInPaisa = 10_000, customerId = null, status = "pending" } = opts;
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: targetRestaurantId,
        branchId: targetBranchId,
        orderNumber: `TEST-CPN-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status,
        customerId,
        subtotalInPaisa,
        taxInPaisa: 0,
        totalInPaisa: subtotalInPaisa,
      })
      .returning();
    return order;
  }

  /** Two order-item lines — TEST Cola (drink, Rs 2000) and TEST Momo (food, Rs 8000) — summing to the default 10,000-paisa order subtotal used by makeOrder's own default, for the menu/category restriction tests. */
  async function addDrinkAndFoodLines(orderId: string) {
    await db.insert(schema.orderItems).values([
      {
        orderId,
        menuItemId: menuItemDrinkId,
        menuItemNameSnapshot: "TEST Cola",
        unitPriceInPaisa: 2_000,
        quantity: 1,
        lineSubtotalInPaisa: 2_000,
        lineTotalInPaisa: 2_000,
      },
      {
        orderId,
        menuItemId: menuItemFoodId,
        menuItemNameSnapshot: "TEST Momo",
        unitPriceInPaisa: 8_000,
        quantity: 1,
        lineSubtotalInPaisa: 8_000,
        lineTotalInPaisa: 8_000,
      },
    ]);
  }

  function contextFor(order: typeof schema.orders.$inferSelect): CouponEligibilityContext {
    return { branchId: order.branchId, customerId: order.customerId, orderId: order.id, orderCreatedAt: order.createdAt };
  }

  async function makeCustomer(overrides: Partial<typeof schema.customers.$inferInsert> = {}) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `98${suffix}`, fullName: "TEST Customer", ...overrides })
      .returning();
    return customer;
  }

  /** Creates a test coupon with sane defaults, overridable per test. */
  async function makeCoupon(overrides: Partial<typeof schema.coupons.$inferInsert> = {}) {
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const [coupon] = await db
      .insert(schema.coupons)
      .values({
        restaurantId,
        code: `TEST${suffix}`,
        discountType: "percentage",
        discountValue: 1_000, // 10.00%
        isActive: true,
        createdByUserId: ownerId,
        ...overrides,
      })
      .returning();
    return coupon;
  }

  it("happy path: resolveCoupon computes a percentage discount, redeemCoupon claims usage and logs a redemption", async () => {
    const coupon = await makeCoupon({ discountType: "percentage", discountValue: 1_000 }); // 10%
    const order = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 10_000 });

    const resolved = await coupons.resolveCoupon(restaurantId, coupon.code.toLowerCase(), 10_000, contextFor(order));
    expect(resolved.discountInPaisa).toBe(1_000); // 10% of 10,000

    const { coupon: claimed, redemption } = await db.transaction((tx) =>
      coupons.redeemCoupon(tx, {
        restaurantId,
        couponId: coupon.id,
        orderId: order.id,
        discountInPaisa: resolved.discountInPaisa,
        recordedByUserId: ownerId,
      }),
    );
    expect(claimed.usageCount).toBe(1);
    expect(redemption.discountInPaisa).toBe(1_000);
    expect(redemption.orderId).toBe(order.id);
  });

  it("happy path: a flat coupon resolves to its exact paisa amount, clamped to the subtotal", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 5_000 });
    const orderSmall = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 3_000 });
    const small = await coupons.resolveCoupon(restaurantId, coupon.code, 3_000, contextFor(orderSmall));
    expect(small.discountInPaisa).toBe(3_000); // clamped — can't discount below zero

    const orderLarge = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 20_000 });
    const large = await coupons.resolveCoupon(restaurantId, coupon.code, 20_000, contextFor(orderLarge));
    expect(large.discountInPaisa).toBe(5_000);
  });

  it("happy path: a percentage coupon's discount is capped by maxDiscountInPaisa", async () => {
    const coupon = await makeCoupon({ discountType: "percentage", discountValue: 5_000, maxDiscountInPaisa: 800 }); // 50%, capped at 800
    const order = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 10_000 });
    const resolved = await coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order));
    expect(resolved.discountInPaisa).toBe(800); // would be 5,000 uncapped
  });

  it("unauthorized/not-found: an unknown code is rejected with 404", async () => {
    const order = await makeOrder(restaurantId, branchId);
    await expect(coupons.resolveCoupon(restaurantId, "DOES-NOT-EXIST", 10_000, contextFor(order))).rejects.toMatchObject({
      status: 404,
    });
  });

  it("wrong-restaurant isolation: a coupon defined for another restaurant is never resolvable here", async () => {
    const foreign = await db
      .insert(schema.coupons)
      .values({
        restaurantId: otherRestaurantId,
        code: "FOREIGN10",
        discountType: "flat",
        discountValue: 1_000,
        isActive: true,
      })
      .returning();

    const order = await makeOrder(restaurantId, branchId);
    await expect(
      coupons.resolveCoupon(restaurantId, foreign[0].code, 10_000, contextFor(order)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("validation failure: an inactive coupon is rejected", async () => {
    const coupon = await makeCoupon({ isActive: false });
    const order = await makeOrder(restaurantId, branchId);
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order))).rejects.toMatchObject({
      status: 404,
    });
  });

  it("validation failure: an expired coupon is rejected", async () => {
    const coupon = await makeCoupon({ expiresAt: new Date(Date.now() - 60_000) });
    const order = await makeOrder(restaurantId, branchId);
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("validation failure: a not-yet-active coupon is rejected", async () => {
    const coupon = await makeCoupon({ startsAt: new Date(Date.now() + 60_000) });
    const order = await makeOrder(restaurantId, branchId);
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("validation failure: an order below minOrderSubtotalInPaisa is rejected", async () => {
    const coupon = await makeCoupon({ minOrderSubtotalInPaisa: 5_000 });
    const orderBelow = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 4_999 });
    await expect(
      coupons.resolveCoupon(restaurantId, coupon.code, 4_999, contextFor(orderBelow)),
    ).rejects.toMatchObject({ status: 400 });
    // Exactly at the minimum succeeds.
    const orderAt = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 5_000 });
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 5_000, contextFor(orderAt))).resolves.toBeTruthy();
  });

  it("edge case / duplicate request: redeemCoupon rejects once usageLimit is reached, even on a fresh code lookup", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 500, usageLimit: 1 });
    const order1 = await makeOrder(restaurantId, branchId);
    const order2 = await makeOrder(restaurantId, branchId);

    await db.transaction((tx) =>
      coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: order1.id, discountInPaisa: 500 }),
    );

    // resolveCoupon's own pre-check should now reject a second attempt...
    await expect(
      coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order2)),
    ).rejects.toMatchObject({ status: 409 });

    // ...and even if a caller bypassed that pre-check, redeemCoupon's own
    // atomic CAS is the real source of truth and rejects it too.
    await expect(
      db.transaction((tx) =>
        coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: order2.id, discountInPaisa: 500 }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("concurrent request / rollback: two simultaneous redemptions against a usageLimit of 1 — exactly one wins", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 500, usageLimit: 1 });
    const orderA = await makeOrder(restaurantId, branchId);
    const orderB = await makeOrder(restaurantId, branchId);

    const attempt = (orderId: string) =>
      db
        .transaction((tx) =>
          coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId, discountInPaisa: 500 }),
        )
        .then(() => ({ ok: true as const }))
        .catch(() => ({ ok: false as const }));

    const [a, b] = await Promise.all([attempt(orderA.id), attempt(orderB.id)]);
    const succeeded = [a, b].filter((o) => o.ok);
    expect(succeeded).toHaveLength(1);

    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
    expect(row.usageCount).toBe(1); // never double-claimed

    const redemptions = await db
      .select()
      .from(schema.couponRedemptions)
      .where(eq(schema.couponRedemptions.couponId, coupon.id));
    expect(redemptions).toHaveLength(1);
  });

  it("rollback: unredeemCoupon releases the usage slot and deletes the redemption row (symmetric inverse of redeemCoupon)", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 500 });
    const order = await makeOrder(restaurantId, branchId);

    await db.transaction((tx) =>
      coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: order.id, discountInPaisa: 500 }),
    );
    let [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
    expect(row.usageCount).toBe(1);

    const released = await db.transaction((tx) =>
      coupons.unredeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: order.id }),
    );
    expect(released).toBe(true);

    [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
    expect(row.usageCount).toBe(0);

    const redemptions = await db
      .select()
      .from(schema.couponRedemptions)
      .where(eq(schema.couponRedemptions.couponId, coupon.id));
    expect(redemptions).toHaveLength(0);

    // Once released, the coupon is redeemable again — proves the slot was
    // genuinely freed, not just cosmetically decremented.
    await expect(
      db.transaction((tx) =>
        coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: order.id, discountInPaisa: 500 }),
      ),
    ).resolves.toBeTruthy();
  });

  it("edge case: unredeemCoupon is a safe no-op (returns false, never goes negative) when there's nothing to release", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 500 });
    const order = await makeOrder(restaurantId, branchId);

    const released = await db.transaction((tx) =>
      coupons.unredeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: order.id }),
    );
    expect(released).toBe(false);

    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
    expect(row.usageCount).toBe(0); // never went negative
  });

  it("wrong-restaurant isolation: unredeemCoupon never releases another restaurant's redemption", async () => {
    const [foreignCoupon] = await db
      .insert(schema.coupons)
      .values({ restaurantId: otherRestaurantId, code: "ISO-COUPON", discountType: "flat", discountValue: 500, isActive: true })
      .returning();
    const foreignOrder = await makeOrder(otherRestaurantId, otherBranchId);

    await db.transaction((tx) =>
      coupons.redeemCoupon(tx, {
        restaurantId: otherRestaurantId,
        couponId: foreignCoupon.id,
        orderId: foreignOrder.id,
        discountInPaisa: 500,
      }),
    );

    // Attempting to release it while scoped to the WRONG restaurant is a no-op.
    const released = await db.transaction((tx) =>
      coupons.unredeemCoupon(tx, { restaurantId, couponId: foreignCoupon.id, orderId: foreignOrder.id }),
    );
    expect(released).toBe(false);

    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, foreignCoupon.id));
    expect(row.usageCount).toBe(1); // untouched
  });

  it("edge case: a null-usageLimit coupon (unlimited) can be redeemed repeatedly", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 100, usageLimit: null });
    for (let i = 0; i < 3; i += 1) {
      const order = await makeOrder(restaurantId, branchId);
      await db.transaction((tx) =>
        coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: order.id, discountInPaisa: 100 }),
      );
    }
    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
    expect(row.usageCount).toBe(3);
  });

  it("validation failure: normalizeCouponCode/resolveCoupon reject an empty code", async () => {
    const order = await makeOrder(restaurantId, branchId);
    await expect(coupons.resolveCoupon(restaurantId, "   ", 10_000, contextFor(order))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("edge case: coupon codes are matched case-insensitively via normalizeCouponCode", async () => {
    const coupon = await makeCoupon({ code: "MIXEDCASE10", discountType: "flat", discountValue: 200 });
    const order = await makeOrder(restaurantId, branchId);
    const resolved = await coupons.resolveCoupon(restaurantId, "mixedcase10", 10_000, contextFor(order));
    expect(resolved.coupon.id).toBe(coupon.id);
  });

  // ---------------------------------------------------------------------
  // Branch restriction
  // ---------------------------------------------------------------------

  describe("branch restriction", () => {
    it("a coupon with no couponBranches rows is valid at every branch (unrestricted, pre-existing behavior)", async () => {
      const coupon = await makeCoupon({ discountType: "flat", discountValue: 100 });
      const order = await makeOrder(restaurantId, branchId2);
      await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order))).resolves.toBeTruthy();
    });

    it("an order at a listed branch succeeds; an order at an unlisted branch is rejected", async () => {
      const coupon = await makeCoupon({ discountType: "flat", discountValue: 100 });
      await db.insert(schema.couponBranches).values({ restaurantId, couponId: coupon.id, branchId });

      const orderAtListed = await makeOrder(restaurantId, branchId);
      await expect(
        coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(orderAtListed)),
      ).resolves.toBeTruthy();

      const orderAtOther = await makeOrder(restaurantId, branchId2);
      await expect(
        coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(orderAtOther)),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  // ---------------------------------------------------------------------
  // Menu-item / category restriction — discount computed on qualifying
  // items' subtotal only, not the whole order (see coupons.ts's own
  // comment on resolveCoupon for the full reasoning).
  // ---------------------------------------------------------------------

  describe("menu-item / category restriction", () => {
    it("restricted to a specific menu item: discount is computed against only that item's lineTotal, not the full order subtotal", async () => {
      // 50% off, restricted to the Rs 2000 drink line — order also has an
      // Rs 8000 food line (Rs 10,000 total). Uncapped 50% of the full
      // order would be Rs 5000; the qualifying-items-only rule caps it at
      // 50% of Rs 2000 = Rs 1000.
      const coupon = await makeCoupon({ discountType: "percentage", discountValue: 5_000 });
      await db.insert(schema.couponMenuItems).values({ restaurantId, couponId: coupon.id, menuItemId: menuItemDrinkId });

      const order = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 10_000 });
      await addDrinkAndFoodLines(order.id);

      const resolved = await coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order));
      expect(resolved.discountInPaisa).toBe(1_000);
    });

    it("restricted to a category: discount is computed against only that category's items", async () => {
      const coupon = await makeCoupon({ discountType: "percentage", discountValue: 5_000 });
      await db.insert(schema.couponCategories).values({ restaurantId, couponId: coupon.id, categoryId: categoryDrinksId });

      const order = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 10_000 });
      await addDrinkAndFoodLines(order.id);

      const resolved = await coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order));
      expect(resolved.discountInPaisa).toBe(1_000); // same as the menu-item test — the drink is in this category
    });

    it("restricted to an item/category not present in the cart is rejected rather than silently discounting Rs 0", async () => {
      const coupon = await makeCoupon({ discountType: "percentage", discountValue: 5_000 });
      await db.insert(schema.couponCategories).values({ restaurantId, couponId: coupon.id, categoryId: categoryFoodId });

      // Order has ONLY the drink line — no food line — so nothing qualifies.
      const order = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 2_000 });
      await db.insert(schema.orderItems).values({
        orderId: order.id,
        menuItemId: menuItemDrinkId,
        menuItemNameSnapshot: "TEST Cola",
        unitPriceInPaisa: 2_000,
        quantity: 1,
        lineSubtotalInPaisa: 2_000,
        lineTotalInPaisa: 2_000,
      });

      await expect(coupons.resolveCoupon(restaurantId, coupon.code, 2_000, contextFor(order))).rejects.toMatchObject({
        status: 400,
      });
    });

    it("an item/category allow-list restriction on a coupon otherwise matches either list (OR, not AND)", async () => {
      const coupon = await makeCoupon({ discountType: "flat", discountValue: 10_000 }); // would clamp to whole order if unrestricted
      // menu-item list names the FOOD item; category list names DRINKS —
      // both lines should qualify since each matches one of the two lists.
      await db.insert(schema.couponMenuItems).values({ restaurantId, couponId: coupon.id, menuItemId: menuItemFoodId });
      await db.insert(schema.couponCategories).values({ restaurantId, couponId: coupon.id, categoryId: categoryDrinksId });

      const order = await makeOrder(restaurantId, branchId, { subtotalInPaisa: 10_000 });
      await addDrinkAndFoodLines(order.id);

      const resolved = await coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order));
      expect(resolved.discountInPaisa).toBe(10_000); // both lines qualify — full order subtotal
    });
  });

  // ---------------------------------------------------------------------
  // First-order-only
  // ---------------------------------------------------------------------

  describe("first-order-only", () => {
    it("a customer's only order is their first order — coupon resolves", async () => {
      const customer = await makeCustomer();
      const order = await makeOrder(restaurantId, branchId, { customerId: customer.id });
      const coupon = await makeCoupon({ firstOrderOnly: true, discountType: "flat", discountValue: 100 });

      await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order))).resolves.toBeTruthy();
    });

    it("a customer's SECOND order is rejected, regardless of which order the coupon is tried on first", async () => {
      const customer = await makeCustomer();
      const firstOrder = await makeOrder(restaurantId, branchId, { customerId: customer.id });
      // Ensure a strictly later createdAt than firstOrder for a deterministic ordering.
      await new Promise((r) => setTimeout(r, 5));
      const secondOrder = await makeOrder(restaurantId, branchId, { customerId: customer.id });

      const coupon = await makeCoupon({ firstOrderOnly: true, discountType: "flat", discountValue: 100 });

      await expect(
        coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(secondOrder)),
      ).rejects.toMatchObject({ status: 400 });
      // The TRUE first order still qualifies.
      await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(firstOrder))).resolves.toBeTruthy();
    });

    it("a cancelled earlier order doesn't count against 'first' — the next real order still qualifies", async () => {
      const customer = await makeCustomer();
      const cancelledOrder = await makeOrder(restaurantId, branchId, { customerId: customer.id, status: "cancelled" });
      await new Promise((r) => setTimeout(r, 5));
      const realOrder = await makeOrder(restaurantId, branchId, { customerId: customer.id });

      const coupon = await makeCoupon({ firstOrderOnly: true, discountType: "flat", discountValue: 100 });
      await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(realOrder))).resolves.toBeTruthy();
      void cancelledOrder;
    });

    it("a guest order with no linked customer can never satisfy firstOrderOnly", async () => {
      const order = await makeOrder(restaurantId, branchId); // no customerId
      const coupon = await makeCoupon({ firstOrderOnly: true, discountType: "flat", discountValue: 100 });
      await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(order))).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  // ---------------------------------------------------------------------
  // Per-customer usage cap — the P1 leak this whole feature closes.
  // Mirrors the global-usage-limit tests above in rigor: a sequential
  // duplicate-attempt test AND a genuine concurrent-request race test.
  // ---------------------------------------------------------------------

  describe("per-customer usage cap", () => {
    it("resolveCoupon's precheck rejects once a customer's perCustomerLimit is reached, but a DIFFERENT customer is unaffected", async () => {
      const coupon = await makeCoupon({ discountType: "flat", discountValue: 500, perCustomerLimit: 1 });
      const customerA = await makeCustomer();
      const customerB = await makeCustomer();

      const orderA1 = await makeOrder(restaurantId, branchId, { customerId: customerA.id });
      await db.transaction((tx) =>
        coupons.redeemCoupon(tx, {
          restaurantId,
          couponId: coupon.id,
          orderId: orderA1.id,
          discountInPaisa: 500,
          customerId: customerA.id,
        }),
      );

      const orderA2 = await makeOrder(restaurantId, branchId, { customerId: customerA.id });
      await expect(
        coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(orderA2)),
      ).rejects.toMatchObject({ status: 409 });

      // redeemCoupon's own CAS is the real source of truth, same as the global cap.
      await expect(
        db.transaction((tx) =>
          coupons.redeemCoupon(tx, {
            restaurantId,
            couponId: coupon.id,
            orderId: orderA2.id,
            discountInPaisa: 500,
            customerId: customerA.id,
          }),
        ),
      ).rejects.toMatchObject({ status: 409 });

      // Customer B has their own independent counter.
      const orderB1 = await makeOrder(restaurantId, branchId, { customerId: customerB.id });
      await expect(
        coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(orderB1)),
      ).resolves.toBeTruthy();
    });

    it("concurrent request / rollback: two simultaneous redemptions by the SAME customer against a perCustomerLimit of 1 — exactly one wins", async () => {
      const coupon = await makeCoupon({ discountType: "flat", discountValue: 500, perCustomerLimit: 1 });
      const customer = await makeCustomer();
      const orderA = await makeOrder(restaurantId, branchId, { customerId: customer.id });
      const orderB = await makeOrder(restaurantId, branchId, { customerId: customer.id });

      const attempt = (orderId: string) =>
        db
          .transaction((tx) =>
            coupons.redeemCoupon(tx, {
              restaurantId,
              couponId: coupon.id,
              orderId,
              discountInPaisa: 500,
              customerId: customer.id,
            }),
          )
          .then(() => ({ ok: true as const }))
          .catch(() => ({ ok: false as const }));

      const [a, b] = await Promise.all([attempt(orderA.id), attempt(orderB.id)]);
      const succeeded = [a, b].filter((o) => o.ok);
      expect(succeeded).toHaveLength(1);

      const [counterRow] = await db
        .select()
        .from(schema.couponCustomerRedemptions)
        .where(
          eq(schema.couponCustomerRedemptions.couponId, coupon.id),
        );
      expect(counterRow.redemptionCount).toBe(1); // never double-claimed, no matter which of the two won

      const redemptions = await db
        .select()
        .from(schema.couponRedemptions)
        .where(eq(schema.couponRedemptions.couponId, coupon.id));
      expect(redemptions).toHaveLength(1);

      // The GLOBAL counter also reflects exactly one claim (both caps are
      // consistent with each other, not just individually correct).
      const [couponRow] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
      expect(couponRow.usageCount).toBe(1);
    });

    it("a coupon with perCustomerLimit set requires a linked customer — a guest order is rejected by both resolveCoupon and redeemCoupon", async () => {
      const coupon = await makeCoupon({ discountType: "flat", discountValue: 500, perCustomerLimit: 1 });
      const guestOrder = await makeOrder(restaurantId, branchId); // no customerId

      await expect(
        coupons.resolveCoupon(restaurantId, coupon.code, 10_000, contextFor(guestOrder)),
      ).rejects.toMatchObject({ status: 400 });

      // Defense in depth — even bypassing resolveCoupon, redeemCoupon itself refuses.
      await expect(
        db.transaction((tx) =>
          coupons.redeemCoupon(tx, {
            restaurantId,
            couponId: coupon.id,
            orderId: guestOrder.id,
            discountInPaisa: 500,
            customerId: null,
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("unredeemCoupon releases the per-customer slot too (symmetric with the global one), and it becomes redeemable again", async () => {
      const coupon = await makeCoupon({ discountType: "flat", discountValue: 500, perCustomerLimit: 1 });
      const customer = await makeCustomer();
      const order = await makeOrder(restaurantId, branchId, { customerId: customer.id });

      await db.transaction((tx) =>
        coupons.redeemCoupon(tx, {
          restaurantId,
          couponId: coupon.id,
          orderId: order.id,
          discountInPaisa: 500,
          customerId: customer.id,
        }),
      );
      let [counterRow] = await db
        .select()
        .from(schema.couponCustomerRedemptions)
        .where(eq(schema.couponCustomerRedemptions.couponId, coupon.id));
      expect(counterRow.redemptionCount).toBe(1);

      await db.transaction((tx) => coupons.unredeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: order.id }));

      [counterRow] = await db
        .select()
        .from(schema.couponCustomerRedemptions)
        .where(eq(schema.couponCustomerRedemptions.couponId, coupon.id));
      expect(counterRow.redemptionCount).toBe(0);

      // Redeemable again for the same customer, on a fresh order.
      const order2 = await makeOrder(restaurantId, branchId, { customerId: customer.id });
      await expect(
        db.transaction((tx) =>
          coupons.redeemCoupon(tx, {
            restaurantId,
            couponId: coupon.id,
            orderId: order2.id,
            discountInPaisa: 500,
            customerId: customer.id,
          }),
        ),
      ).resolves.toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------
  // Tenant isolation for the new restriction-ownership check
  // ---------------------------------------------------------------------

  describe("assertCouponRestrictionsOwnership", () => {
    it("rejects a branch/menu-item/category id that belongs to a DIFFERENT restaurant", async () => {
      await expect(
        coupons.assertCouponRestrictionsOwnership(restaurantId, { branchIds: [otherBranchId] }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        coupons.assertCouponRestrictionsOwnership(restaurantId, { menuItemIds: [otherMenuItemId] }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("accepts ids that genuinely belong to this restaurant", async () => {
      await expect(
        coupons.assertCouponRestrictionsOwnership(restaurantId, {
          branchIds: [branchId],
          menuItemIds: [menuItemDrinkId],
          categoryIds: [categoryDrinksId],
        }),
      ).resolves.toBeUndefined();
    });
  });
});
