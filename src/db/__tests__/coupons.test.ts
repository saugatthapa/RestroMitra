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
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Coupons (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let coupons: typeof import("@/lib/coupons");

  let ownerId: string;
  let restaurantId: string;
  let otherRestaurantId: string;
  let branchId: string;
  let otherBranchId: string;

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

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    otherBranchId = otherBranch.id;
  });

  afterAll(async () => {
    await db.delete(schema.couponRedemptions).where(eq(schema.couponRedemptions.restaurantId, restaurantId));
    await db.delete(schema.couponRedemptions).where(eq(schema.couponRedemptions.restaurantId, otherRestaurantId));
    await db.delete(schema.coupons).where(eq(schema.coupons.restaurantId, restaurantId));
    await db.delete(schema.coupons).where(eq(schema.coupons.restaurantId, otherRestaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, otherRestaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchId));
    await db.delete(schema.branches).where(eq(schema.branches.id, otherBranchId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  /** Creates a bare test order to redeem coupons against (couponRedemptions.orderId is NOT NULL). */
  async function makeOrder(targetRestaurantId: string, targetBranchId: string, subtotalInPaisa = 10_000) {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: targetRestaurantId,
        branchId: targetBranchId,
        orderNumber: `TEST-CPN-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa,
        taxInPaisa: 0,
        totalInPaisa: subtotalInPaisa,
      })
      .returning({ id: schema.orders.id });
    return order.id;
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
    const orderId = await makeOrder(restaurantId, branchId, 10_000);

    const resolved = await coupons.resolveCoupon(restaurantId, coupon.code.toLowerCase(), 10_000);
    expect(resolved.discountInPaisa).toBe(1_000); // 10% of 10,000

    const { coupon: claimed, redemption } = await db.transaction((tx) =>
      coupons.redeemCoupon(tx, {
        restaurantId,
        couponId: coupon.id,
        orderId,
        discountInPaisa: resolved.discountInPaisa,
        recordedByUserId: ownerId,
      }),
    );
    expect(claimed.usageCount).toBe(1);
    expect(redemption.discountInPaisa).toBe(1_000);
    expect(redemption.orderId).toBe(orderId);
  });

  it("happy path: a flat coupon resolves to its exact paisa amount, clamped to the subtotal", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 5_000 });
    const small = await coupons.resolveCoupon(restaurantId, coupon.code, 3_000);
    expect(small.discountInPaisa).toBe(3_000); // clamped — can't discount below zero

    const large = await coupons.resolveCoupon(restaurantId, coupon.code, 20_000);
    expect(large.discountInPaisa).toBe(5_000);
  });

  it("happy path: a percentage coupon's discount is capped by maxDiscountInPaisa", async () => {
    const coupon = await makeCoupon({ discountType: "percentage", discountValue: 5_000, maxDiscountInPaisa: 800 }); // 50%, capped at 800
    const resolved = await coupons.resolveCoupon(restaurantId, coupon.code, 10_000);
    expect(resolved.discountInPaisa).toBe(800); // would be 5,000 uncapped
  });

  it("unauthorized/not-found: an unknown code is rejected with 404", async () => {
    await expect(coupons.resolveCoupon(restaurantId, "DOES-NOT-EXIST", 10_000)).rejects.toMatchObject({ status: 404 });
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

    await expect(coupons.resolveCoupon(restaurantId, foreign[0].code, 10_000)).rejects.toMatchObject({ status: 404 });
  });

  it("validation failure: an inactive coupon is rejected", async () => {
    const coupon = await makeCoupon({ isActive: false });
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000)).rejects.toMatchObject({ status: 404 });
  });

  it("validation failure: an expired coupon is rejected", async () => {
    const coupon = await makeCoupon({ expiresAt: new Date(Date.now() - 60_000) });
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000)).rejects.toMatchObject({ status: 400 });
  });

  it("validation failure: a not-yet-active coupon is rejected", async () => {
    const coupon = await makeCoupon({ startsAt: new Date(Date.now() + 60_000) });
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000)).rejects.toMatchObject({ status: 400 });
  });

  it("validation failure: an order below minOrderSubtotalInPaisa is rejected", async () => {
    const coupon = await makeCoupon({ minOrderSubtotalInPaisa: 5_000 });
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 4_999)).rejects.toMatchObject({ status: 400 });
    // Exactly at the minimum succeeds.
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 5_000)).resolves.toBeTruthy();
  });

  it("edge case / duplicate request: redeemCoupon rejects once usageLimit is reached, even on a fresh code lookup", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 500, usageLimit: 1 });
    const orderId1 = await makeOrder(restaurantId, branchId);
    const orderId2 = await makeOrder(restaurantId, branchId);

    await db.transaction((tx) =>
      coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: orderId1, discountInPaisa: 500 }),
    );

    // resolveCoupon's own pre-check should now reject a second attempt...
    await expect(coupons.resolveCoupon(restaurantId, coupon.code, 10_000)).rejects.toMatchObject({ status: 409 });

    // ...and even if a caller bypassed that pre-check, redeemCoupon's own
    // atomic CAS is the real source of truth and rejects it too.
    await expect(
      db.transaction((tx) =>
        coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId: orderId2, discountInPaisa: 500 }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("concurrent request / rollback: two simultaneous redemptions against a usageLimit of 1 — exactly one wins", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 500, usageLimit: 1 });
    const orderIdA = await makeOrder(restaurantId, branchId);
    const orderIdB = await makeOrder(restaurantId, branchId);

    const attempt = (orderId: string) =>
      db
        .transaction((tx) =>
          coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId, discountInPaisa: 500 }),
        )
        .then(() => ({ ok: true as const }))
        .catch(() => ({ ok: false as const }));

    const [a, b] = await Promise.all([attempt(orderIdA), attempt(orderIdB)]);
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
    const orderId = await makeOrder(restaurantId, branchId);

    await db.transaction((tx) =>
      coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId, discountInPaisa: 500 }),
    );
    let [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
    expect(row.usageCount).toBe(1);

    const released = await db.transaction((tx) => coupons.unredeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId }));
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
        coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId, discountInPaisa: 500 }),
      ),
    ).resolves.toBeTruthy();
  });

  it("edge case: unredeemCoupon is a safe no-op (returns false, never goes negative) when there's nothing to release", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 500 });
    const orderId = await makeOrder(restaurantId, branchId);

    const released = await db.transaction((tx) => coupons.unredeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId }));
    expect(released).toBe(false);

    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
    expect(row.usageCount).toBe(0); // never went negative
  });

  it("wrong-restaurant isolation: unredeemCoupon never releases another restaurant's redemption", async () => {
    const [foreignCoupon] = await db
      .insert(schema.coupons)
      .values({ restaurantId: otherRestaurantId, code: "ISO-COUPON", discountType: "flat", discountValue: 500, isActive: true })
      .returning();
    const foreignOrderId = await makeOrder(otherRestaurantId, otherBranchId);

    await db.transaction((tx) =>
      coupons.redeemCoupon(tx, {
        restaurantId: otherRestaurantId,
        couponId: foreignCoupon.id,
        orderId: foreignOrderId,
        discountInPaisa: 500,
      }),
    );

    // Attempting to release it while scoped to the WRONG restaurant is a no-op.
    const released = await db.transaction((tx) =>
      coupons.unredeemCoupon(tx, { restaurantId, couponId: foreignCoupon.id, orderId: foreignOrderId }),
    );
    expect(released).toBe(false);

    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, foreignCoupon.id));
    expect(row.usageCount).toBe(1); // untouched
  });

  it("edge case: a null-usageLimit coupon (unlimited) can be redeemed repeatedly", async () => {
    const coupon = await makeCoupon({ discountType: "flat", discountValue: 100, usageLimit: null });
    for (let i = 0; i < 3; i += 1) {
      const orderId = await makeOrder(restaurantId, branchId);
      await db.transaction((tx) =>
        coupons.redeemCoupon(tx, { restaurantId, couponId: coupon.id, orderId, discountInPaisa: 100 }),
      );
    }
    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
    expect(row.usageCount).toBe(3);
  });

  it("validation failure: normalizeCouponCode/resolveCoupon reject an empty code", async () => {
    await expect(coupons.resolveCoupon(restaurantId, "   ", 10_000)).rejects.toMatchObject({ status: 400 });
  });

  it("edge case: coupon codes are matched case-insensitively via normalizeCouponCode", async () => {
    const coupon = await makeCoupon({ code: "MIXEDCASE10", discountType: "flat", discountValue: 200 });
    const resolved = await coupons.resolveCoupon(restaurantId, "mixedcase10", 10_000);
    expect(resolved.coupon.id).toBe(coupon.id);
  });
});
