/**
 * Commercial completion pass (Data Export gap — orders) integration tests
 * for listOrdersForExport() in src/lib/orders.ts — the function backing
 * GET /api/restaurants/[slug]/orders/export. RBAC/permission gating
 * (VIEW_SALES) lives in the route itself and resolveRestaurantContext's
 * own tests already cover that layer (see ledger-list.test.ts's own
 * comment on the same split) — this file exercises the query's tenant
 * isolation, date-range filtering, and branch scoping directly.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("listOrdersForExport (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let orders: typeof import("@/lib/orders");

  let restaurantId: string;
  let otherRestaurantId: string;
  let branchAId: string;
  let branchBId: string;
  let otherBranchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    orders = await import("@/lib/orders");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-orders-export-${suffix}`, name: "TEST Orders Export Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-orders-export-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch A", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch B" })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Other Restaurant Main", isMain: true })
      .returning({ id: schema.branches.id });
    otherBranchId = otherBranch.id;
  });

  afterAll(async () => {
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, otherRestaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  function insertOrder(params: {
    targetRestaurantId: string;
    branchId: string;
    orderNumber: string;
    placedAt: Date;
    totalInPaisa?: number;
  }) {
    return db
      .insert(schema.orders)
      .values({
        restaurantId: params.targetRestaurantId,
        branchId: params.branchId,
        orderNumber: params.orderNumber,
        placedAt: params.placedAt,
        subtotalInPaisa: params.totalInPaisa ?? 1_000,
        taxInPaisa: 0,
        totalInPaisa: params.totalInPaisa ?? 1_000,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  it("happy path: lists orders for the restaurant, newest placedAt first", async () => {
    await insertOrder({
      targetRestaurantId: restaurantId,
      branchId: branchAId,
      orderNumber: "ORD-EARLY",
      placedAt: new Date("2026-01-01T10:00:00Z"),
    });
    await insertOrder({
      targetRestaurantId: restaurantId,
      branchId: branchAId,
      orderNumber: "ORD-LATE",
      placedAt: new Date("2026-01-05T10:00:00Z"),
    });

    const rows = await orders.listOrdersForExport(restaurantId, {}, "UTC", 100);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const numbers = rows.map((r) => r.orderNumber);
    const idxLate = numbers.indexOf("ORD-LATE");
    const idxEarly = numbers.indexOf("ORD-EARLY");
    expect(idxLate).toBeGreaterThanOrEqual(0);
    expect(idxEarly).toBeGreaterThan(idxLate);
  });

  it("wrong-restaurant isolation: never returns another restaurant's orders", async () => {
    const other = await insertOrder({
      targetRestaurantId: otherRestaurantId,
      branchId: otherBranchId,
      orderNumber: "ORD-OTHER-RESTO",
      placedAt: new Date("2026-01-01T10:00:00Z"),
    });

    const rows = await orders.listOrdersForExport(restaurantId, {}, "UTC", 100);
    expect(rows.some((r) => r.id === other.id)).toBe(false);
  });

  it("filters by date range (from/to, inclusive of the whole `to` day)", async () => {
    await insertOrder({
      targetRestaurantId: restaurantId,
      branchId: branchAId,
      orderNumber: "ORD-FEB-01",
      placedAt: new Date("2026-02-01T05:00:00Z"),
    });
    await insertOrder({
      targetRestaurantId: restaurantId,
      branchId: branchAId,
      orderNumber: "ORD-FEB-15",
      placedAt: new Date("2026-02-15T05:00:00Z"),
    });
    await insertOrder({
      targetRestaurantId: restaurantId,
      branchId: branchAId,
      orderNumber: "ORD-MAR-01",
      placedAt: new Date("2026-03-01T05:00:00Z"),
    });

    const rows = await orders.listOrdersForExport(
      restaurantId,
      { from: "2026-02-01", to: "2026-02-28" },
      "UTC",
      100,
    );
    const numbers = rows.map((r) => r.orderNumber);
    expect(numbers).toContain("ORD-FEB-01");
    expect(numbers).toContain("ORD-FEB-15");
    expect(numbers).not.toContain("ORD-MAR-01");
  });

  it("scopes to one branch when branchId is given", async () => {
    const inBranch = await insertOrder({
      targetRestaurantId: restaurantId,
      branchId: branchBId,
      orderNumber: "ORD-BRANCH-B",
      placedAt: new Date("2026-04-01T10:00:00Z"),
    });
    const otherBranch = await insertOrder({
      targetRestaurantId: restaurantId,
      branchId: branchAId,
      orderNumber: "ORD-BRANCH-A",
      placedAt: new Date("2026-04-01T10:00:00Z"),
    });

    const rows = await orders.listOrdersForExport(restaurantId, { branchId: branchBId }, "UTC", 100);
    expect(rows.some((r) => r.id === inBranch.id)).toBe(true);
    expect(rows.some((r) => r.id === otherBranch.id)).toBe(false);
  });

  it("respects a custom limit", async () => {
    const rows = await orders.listOrdersForExport(restaurantId, {}, "UTC", 1);
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it("edge case: a filter matching nothing returns an empty array, not an error", async () => {
    const rows = await orders.listOrdersForExport(restaurantId, { from: "1999-01-01", to: "1999-01-02" }, "UTC", 100);
    expect(rows).toEqual([]);
  });
});
