/**
 * RC audit P1 regression test: proves getSalesSummary/getCogsSummary
 * (src/lib/reports.ts) correctly account for refunds against completed
 * orders — previously neither did, so a fully refunded order still counted
 * its full totalInPaisa as revenue and its full recipe cost as COGS
 * forever (there is no "refunded"/"voided" order status; `completed` is
 * terminal, and a refund only ever touches orders.paymentStatus via a
 * negative-amount `payments` row).
 *
 * Three orders, same menu item/recipe (reusing cogs-reporting.test.ts's
 * bun+cheese fixture — 4,400 paisa/serving) so the fixed cost per order is
 * identical and only the refund handling varies:
 *   - Order A: paid in full, then refunded in full — expected to
 *     contribute 0 net revenue and be fully excluded from COGS.
 *   - Order B: paid in full, never refunded — the ordinary case, counts in
 *     full both ways (the control).
 *   - Order C: paid in full, then PARTIALLY refunded — revenue nets down
 *     by the refunded amount, but COGS still counts the full recipe cost
 *     (documented, intentional limitation: there's no line-item link
 *     between a refund and specific order_items, so there's no correct
 *     way to reduce COGS proportionally for a partial refund).
 *
 * Kept as its own file/fixture, same reasoning as cogs-reporting.test.ts's
 * own header comment — exact hand-computed totals that a shared fixture
 * order placed inside the same range would silently perturb.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Reports refund exclusion (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let reports: typeof import("@/lib/reports");

  let restaurantId: string;
  let branchId: string;

  const RANGE = { from: "2026-09-01", to: "2026-09-07" };
  const TZ = "UTC";
  const ORDER_TOTAL = 25_000; // one burger, matching the price below
  const RECIPE_COST_PER_SERVING = 4_400; // bun (2_000) + 30g cheese (2_400), same as cogs-reporting.test.ts

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    reports = await import("@/lib/reports");
    const { generateOrderNumber } = await import("@/lib/orders");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-refund-excl-${suffix}`, name: "TEST Refund Exclusion Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId, name: "TEST Refund Category" })
      .returning({ id: schema.categories.id });

    const [burger] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId: category.id, name: "TEST Refund Burger", basePriceInPaisa: ORDER_TOTAL })
      .returning({ id: schema.menuItems.id });

    const [bun] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Refund Bun", unit: "piece", costPerUnitInPaisa: 2_000 })
      .returning({ id: schema.inventoryItems.id });
    const [cheese] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Refund Cheese", unit: "kg", costPerUnitInPaisa: 80_000 })
      .returning({ id: schema.inventoryItems.id });

    await db.insert(schema.recipeItems).values([
      { restaurantId, menuItemId: burger.id, inventoryItemId: bun.id, quantityPerServingMilliunits: 1000 },
      { restaurantId, menuItemId: burger.id, inventoryItemId: cheese.id, quantityPerServingMilliunits: 30 },
    ]);

    async function makeOrder(label: string) {
      const [order] = await db
        .insert(schema.orders)
        .values({
          restaurantId,
          branchId,
          tableId: null,
          orderNumber: generateOrderNumber("UTC"),
          source: "pos",
          status: "completed",
          subtotalInPaisa: ORDER_TOTAL,
          taxInPaisa: 0,
          totalInPaisa: ORDER_TOTAL,
          placedAt: new Date("2026-09-03T10:00:00Z"),
        })
        .returning({ id: schema.orders.id });
      await db.insert(schema.orderItems).values({
        orderId: order.id,
        menuItemId: burger.id,
        menuItemNameSnapshot: label,
        unitPriceInPaisa: ORDER_TOTAL,
        quantity: 1,
        lineSubtotalInPaisa: ORDER_TOTAL,
        lineTotalInPaisa: ORDER_TOTAL,
      });
      return order.id;
    }

    const orderAId = await makeOrder("TEST Fully Refunded Burger");
    const orderBId = await makeOrder("TEST Never Refunded Burger");
    const orderCId = await makeOrder("TEST Partially Refunded Burger");

    await db.insert(schema.payments).values([
      // Order A: paid in full, then refunded in full.
      { restaurantId, orderId: orderAId, amountInPaisa: ORDER_TOTAL, method: "cash" },
      { restaurantId, orderId: orderAId, amountInPaisa: -ORDER_TOTAL, method: "cash" },
      // Order B: paid in full, never refunded.
      { restaurantId, orderId: orderBId, amountInPaisa: ORDER_TOTAL, method: "cash" },
      // Order C: paid in full, partially refunded (Rs 100 of Rs 250).
      { restaurantId, orderId: orderCId, amountInPaisa: ORDER_TOTAL, method: "cash" },
      { restaurantId, orderId: orderCId, amountInPaisa: -10_000, method: "cash" },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("getSalesSummary nets full refunds to zero and partial refunds down, leaving the untouched order at full price", async () => {
    const sales = await reports.getSalesSummary(restaurantId, RANGE, TZ);
    // A: 25_000 - 25_000 = 0. B: 25_000. C: 25_000 - 10_000 = 15_000.
    expect(sales.revenueInPaisa).toBe(0 + ORDER_TOTAL + 15_000);
    // orderCount is still every completed order, refunded or not — a
    // refund doesn't un-complete the order.
    expect(sales.orderCount).toBe(3);
  });

  it("getCogsSummary excludes the fully-refunded order's recipe cost but still counts the partially-refunded one in full", async () => {
    const cogs = await reports.getCogsSummary(restaurantId, RANGE, TZ);
    // Order A excluded entirely (0). Order B: 4_400. Order C: 4_400 (partial
    // refund does NOT reduce COGS — documented limitation).
    expect(cogs.cogsInPaisa).toBe(RECIPE_COST_PER_SERVING * 2);
    // Same menu item across the two counted orders — distinct count stays 1.
    expect(cogs.soldItemCount).toBe(1);
    expect(cogs.itemsWithRecipeCount).toBe(1);
  });

  it("an order with no payments at all (never paid, not refunded) still counts in full — only an actual refund excludes", async () => {
    const { generateOrderNumber } = await import("@/lib/orders");
    const [category] = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(eq(schema.categories.restaurantId, restaurantId))
      .limit(1);
    const [burger] = await db
      .select({ id: schema.menuItems.id })
      .from(schema.menuItems)
      .where(eq(schema.menuItems.restaurantId, restaurantId))
      .limit(1);
    void category;

    const [unpaidOrder] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        tableId: null,
        orderNumber: generateOrderNumber("UTC"),
        source: "pos",
        status: "completed",
        subtotalInPaisa: ORDER_TOTAL,
        taxInPaisa: 0,
        totalInPaisa: ORDER_TOTAL,
        placedAt: new Date("2026-09-04T10:00:00Z"),
      })
      .returning({ id: schema.orders.id });
    await db.insert(schema.orderItems).values({
      orderId: unpaidOrder.id,
      menuItemId: burger.id,
      menuItemNameSnapshot: "TEST Unpaid Burger",
      unitPriceInPaisa: ORDER_TOTAL,
      quantity: 1,
      lineSubtotalInPaisa: ORDER_TOTAL,
      lineTotalInPaisa: ORDER_TOTAL,
    });

    const sales = await reports.getSalesSummary(restaurantId, RANGE, TZ);
    const cogs = await reports.getCogsSummary(restaurantId, RANGE, TZ);
    // Previous 3-order totals plus this unpaid-but-completed 4th order,
    // counted in full on both sides — a net-paid of exactly 0 with NO
    // refund row must not be treated the same as a full refund.
    expect(sales.revenueInPaisa).toBe(0 + ORDER_TOTAL + 15_000 + ORDER_TOTAL);
    expect(cogs.cogsInPaisa).toBe(RECIPE_COST_PER_SERVING * 3);

    await db.delete(schema.orders).where(eq(schema.orders.id, unpaidOrder.id));
  });
});
