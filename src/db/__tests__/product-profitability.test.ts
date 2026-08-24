/**
 * Commercial-launch Phase A.4 regression tests.
 *
 * Covers two things:
 *  1. deductRecipeStockForOrder (src/lib/inventory.ts) now ALSO writes a
 *     frozen orderItems.recipeCostInPaisa snapshot at the moment stock is
 *     deducted — proves it's written for a recipe'd item, left NULL for a
 *     recipe-less one, and — the actual correctness fix this phase exists
 *     for — that getCogsSummary/getProductProfitability (reports.ts)
 *     PREFER that frozen snapshot over live-recomputing from whatever
 *     inventoryItems.costPerUnitInPaisa happens to be today, so a later
 *     purchase changing the weighted-average cost does NOT retroactively
 *     change a past order's reported COGS.
 *  2. getProductProfitability itself: per-item revenue/COGS/gross-profit/
 *     margin math, the null-margin-on-zero-revenue edge case, the
 *     coverage flag, and that it shares getCogsSummary's fully-refunded-
 *     order exclusion.
 *
 * Same convention as every other DB-backed integration test in this
 * project: exercises the actual lib functions directly (no session/route
 * mocking harness here — see cash-register.test.ts's own doc comment).
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);
const TZ = "UTC";

describe.skipIf(!hasDb)("Product profitability / COGS snapshot (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let reports: typeof import("@/lib/reports");
  let inventoryLib: typeof import("@/lib/inventory");
  let generateOrderNumber: (timezone: string) => string;

  let restaurantId: string;
  let branchId: string;
  let categoryId: string;
  let bunId: string;
  let burgerMenuItemId: string;
  let noRecipeMenuItemId: string;
  let freeItemMenuItemId: string;

  const RANGE = { from: "2024-03-01", to: "2024-03-07" };

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    reports = await import("@/lib/reports");
    inventoryLib = await import("@/lib/inventory");
    generateOrderNumber = (await import("@/lib/orders")).generateOrderNumber;

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-profitability-${suffix}`, name: "TEST Profitability Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId, name: "TEST Profitability Category" })
      .returning({ id: schema.categories.id });
    categoryId = category.id;

    const [burger] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST Profitability Burger", basePriceInPaisa: 25_000 })
      .returning({ id: schema.menuItems.id });
    burgerMenuItemId = burger.id;

    const [noRecipeItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST Profitability No-Recipe", basePriceInPaisa: 10_000 })
      .returning({ id: schema.menuItems.id });
    noRecipeMenuItemId = noRecipeItem.id;

    const [freeItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST Profitability Free Sample", basePriceInPaisa: 0 })
      .returning({ id: schema.menuItems.id });
    freeItemMenuItemId = freeItem.id;

    const [bun] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Profitability Bun", unit: "piece", costPerUnitInPaisa: 2_000 })
      .returning({ id: schema.inventoryItems.id });
    bunId = bun.id;

    // 1 whole bun per serving: cost per serving = 2_000 paisa at today's cost.
    await db
      .insert(schema.recipeItems)
      .values({ restaurantId, menuItemId: burgerMenuItemId, inventoryItemId: bunId, quantityPerServingMilliunits: 1000 });
  });

  afterAll(async () => {
    // Both recipe_items.inventoryItemId and branch_inventory_levels.branchId
    // are ON DELETE RESTRICT (see their own schema comments) —
    // deductRecipeStockForOrder's stock movements create branch-level rows
    // via recordStockMovement, and recipeItems references the inventory
    // item directly, so recipe_items must go first, then the inventory
    // item (which cascades its branch-level rows), clearing the way for
    // the restaurant delete's cascade to reach branches cleanly.
    await db.delete(schema.recipeItems).where(eq(schema.recipeItems.restaurantId, restaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function createCompletedOrder(placedAt: Date) {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        tableId: null,
        orderNumber: generateOrderNumber("UTC"),
        source: "pos",
        status: "completed",
        subtotalInPaisa: 0,
        taxInPaisa: 0,
        totalInPaisa: 0,
        placedAt,
      })
      .returning({ id: schema.orders.id });
    return order.id;
  }

  it("deductRecipeStockForOrder writes a frozen recipeCostInPaisa snapshot for a recipe'd item, and leaves it NULL for a recipe-less one", async () => {
    const orderId = await createCompletedOrder(new Date("2024-03-02T10:00:00Z"));
    const [burgerLine] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: burgerMenuItemId,
        menuItemNameSnapshot: "TEST Profitability Burger",
        unitPriceInPaisa: 25_000,
        quantity: 3,
        lineSubtotalInPaisa: 75_000,
        lineTotalInPaisa: 75_000,
      })
      .returning();
    const [noRecipeLine] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: noRecipeMenuItemId,
        menuItemNameSnapshot: "TEST Profitability No-Recipe",
        unitPriceInPaisa: 10_000,
        quantity: 1,
        lineSubtotalInPaisa: 10_000,
        lineTotalInPaisa: 10_000,
      })
      .returning();

    await db.transaction((tx) =>
      inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }),
    );

    const [burgerAfter] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, burgerLine.id));
    const [noRecipeAfter] = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.id, noRecipeLine.id));

    // 3 burgers * 2_000 paisa/serving = 6_000.
    expect(burgerAfter.recipeCostInPaisa).toBe(6_000);
    // No recipe existed for this item — stays NULL (unknown), never 0.
    expect(noRecipeAfter.recipeCostInPaisa).toBeNull();
  });

  it("getCogsSummary uses the FROZEN snapshot, not today's live cost — a later purchase changing the weighted-average cost does not retroactively change past COGS", async () => {
    const orderId = await createCompletedOrder(new Date("2024-03-03T10:00:00Z"));
    const [line] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: burgerMenuItemId,
        menuItemNameSnapshot: "TEST Profitability Burger",
        unitPriceInPaisa: 25_000,
        quantity: 2,
        lineSubtotalInPaisa: 50_000,
        lineTotalInPaisa: 50_000,
      })
      .returning();

    await db.transaction((tx) =>
      inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }),
    );
    const [frozen] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    expect(frozen.recipeCostInPaisa).toBe(4_000); // 2 * 2_000 at the cost when this ran

    // Now the bun gets much more expensive (a later purchase moves the
    // weighted-average cost) — if getCogsSummary re-derived cost live, this
    // order's COGS would silently jump too.
    await db.update(schema.inventoryItems).set({ costPerUnitInPaisa: 50_000 }).where(eq(schema.inventoryItems.id, bunId));

    // Scoped to just this order's own day — RANGE spans the whole week and
    // would also pick up the previous test's burger order.
    const cogs = await reports.getCogsSummary(restaurantId, { from: "2024-03-03", to: "2024-03-03" }, TZ, branchId);
    // Still 4_000, not 2 * 50_000 = 100_000.
    expect(cogs.cogsInPaisa).toBe(4_000);

    // Restore for later tests/assertions in this file.
    await db.update(schema.inventoryItems).set({ costPerUnitInPaisa: 2_000 }).where(eq(schema.inventoryItems.id, bunId));
  });

  it("getCogsSummary still falls back to a live recipe join when recipeCostInPaisa is NULL (a pre-migration row)", async () => {
    const orderId = await createCompletedOrder(new Date("2024-03-04T10:00:00Z"));
    // Inserted directly, bypassing deductRecipeStockForOrder — simulates a
    // row written before this column existed (recipeCostInPaisa stays NULL).
    await db.insert(schema.orderItems).values({
      orderId,
      menuItemId: burgerMenuItemId,
      menuItemNameSnapshot: "TEST Profitability Burger",
      unitPriceInPaisa: 25_000,
      quantity: 1,
      lineSubtotalInPaisa: 25_000,
      lineTotalInPaisa: 25_000,
    });

    const cogs = await reports.getCogsSummary(restaurantId, { from: "2024-03-04", to: "2024-03-04" }, TZ, branchId);
    expect(cogs.cogsInPaisa).toBe(2_000); // live-recomputed: 1 * 2_000
    expect(cogs.itemsWithRecipeCount).toBe(1);
  });

  it("getProductProfitability returns per-item revenue/COGS/gross-profit/margin, null margin on zero revenue, and a coverage flag", async () => {
    const orderId = await createCompletedOrder(new Date("2024-03-05T10:00:00Z"));
    await db.insert(schema.orderItems).values([
      {
        orderId,
        menuItemId: burgerMenuItemId,
        menuItemNameSnapshot: "TEST Profitability Burger",
        unitPriceInPaisa: 25_000,
        quantity: 4,
        lineSubtotalInPaisa: 100_000,
        lineTotalInPaisa: 100_000,
      },
      {
        orderId,
        menuItemId: noRecipeMenuItemId,
        menuItemNameSnapshot: "TEST Profitability No-Recipe",
        unitPriceInPaisa: 10_000,
        quantity: 2,
        lineSubtotalInPaisa: 20_000,
        lineTotalInPaisa: 20_000,
      },
      {
        orderId,
        menuItemId: freeItemMenuItemId,
        menuItemNameSnapshot: "TEST Profitability Free Sample",
        unitPriceInPaisa: 0,
        quantity: 1,
        lineSubtotalInPaisa: 0,
        lineTotalInPaisa: 0,
      },
    ]);
    await db.transaction((tx) =>
      inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }),
    );

    const products = await reports.getProductProfitability(
      restaurantId,
      { from: "2024-03-05", to: "2024-03-05" },
      TZ,
      branchId,
    );

    const burgerRow = products.find((p) => p.name === "TEST Profitability Burger")!;
    expect(burgerRow.quantitySold).toBe(4);
    expect(burgerRow.revenueInPaisa).toBe(100_000);
    expect(burgerRow.cogsInPaisa).toBe(8_000); // 4 * 2_000
    expect(burgerRow.grossProfitInPaisa).toBe(92_000);
    expect(burgerRow.marginPercent).toBeCloseTo(92, 1);
    expect(burgerRow.hasFullCostCoverage).toBe(true);

    const noRecipeRow = products.find((p) => p.name === "TEST Profitability No-Recipe")!;
    expect(noRecipeRow.cogsInPaisa).toBe(0);
    expect(noRecipeRow.hasFullCostCoverage).toBe(false);

    const freeRow = products.find((p) => p.name === "TEST Profitability Free Sample")!;
    expect(freeRow.revenueInPaisa).toBe(0);
    expect(freeRow.marginPercent).toBeNull(); // undefined, not -Infinity% or 0%

    // Default order is revenue-desc.
    expect(products[0].name).toBe("TEST Profitability Burger");
  });

  it("getProductProfitability excludes a fully-refunded order, same as getCogsSummary", async () => {
    const orderId = await createCompletedOrder(new Date("2024-03-06T10:00:00Z"));
    await db.insert(schema.orderItems).values({
      orderId,
      menuItemId: burgerMenuItemId,
      menuItemNameSnapshot: "TEST Profitability Burger",
      unitPriceInPaisa: 25_000,
      quantity: 1,
      lineSubtotalInPaisa: 25_000,
      lineTotalInPaisa: 25_000,
    });
    await db.transaction((tx) =>
      inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }),
    );

    // A payment, then a full refund of it — net paid <= 0 with a refund row present.
    await db.insert(schema.payments).values([
      { restaurantId, orderId, method: "cash", amountInPaisa: 25_000 },
      { restaurantId, orderId, method: "cash", amountInPaisa: -25_000 },
    ]);

    const products = await reports.getProductProfitability(
      restaurantId,
      { from: "2024-03-06", to: "2024-03-06" },
      TZ,
      branchId,
    );
    expect(products).toHaveLength(0);
  });

  it("a branch with no matching orders returns an empty list, not an error", async () => {
    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Profitability Empty Branch", isMain: false })
      .returning({ id: schema.branches.id });
    const products = await reports.getProductProfitability(restaurantId, RANGE, TZ, otherBranch.id);
    expect(products).toEqual([]);
  });
});
