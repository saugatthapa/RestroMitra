/**
 * P2 integration test for getCogsSummary/getReportSummary's COGS fields
 * (src/lib/reports.ts) — proves the recipe-cost math against hand-computed
 * values, that an item with no recipe contributes 0 (not an error) and is
 * reflected in cogsCoverage rather than silently inflating the "complete"
 * signal, and that grossProfitInPaisa = revenue - cogs.
 *
 * Kept as its own file/fixture (not folded into reports-permissions.test.ts)
 * deliberately — that file's assertions are exact hand-computed totals
 * (e.g. revenueInPaisa === 210_000) that a shared-fixture order placed
 * inside its RANGE would silently perturb.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("COGS reporting (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let reports: typeof import("@/lib/reports");

  let restaurantId: string;
  let branchId: string;
  let burgerMenuItemId: string;
  let noRecipeMenuItemId: string;

  const RANGE = { from: "2026-07-01", to: "2026-07-07" };
  const TZ = "UTC";

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    reports = await import("@/lib/reports");
    const { generateOrderNumber } = await import("@/lib/orders");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cogs-${suffix}`, name: "TEST COGS Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId, name: "TEST COGS Category" })
      .returning({ id: schema.categories.id });

    // Burger: 1 recipe line for now — a bun costing Rs 20/unit, 250g
    // (250_000 milliunits of a "gram"... actually inventory units are
    // whole-item units like kg/piece; use "piece" so quantityPerServing=1
    // whole bun keeps the math trivially checkable) per serving.
    const [burger] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId: category.id, name: "TEST Recipe Burger", basePriceInPaisa: 25_000 })
      .returning({ id: schema.menuItems.id });
    burgerMenuItemId = burger.id;

    const [noRecipeItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId: category.id, name: "TEST No-Recipe Item", basePriceInPaisa: 10_000 })
      .returning({ id: schema.menuItems.id });
    noRecipeMenuItemId = noRecipeItem.id;

    const [bun] = await db
      .insert(schema.inventoryItems)
      .values({
        restaurantId,
        name: "TEST Bun",
        unit: "piece",
        costPerUnitInPaisa: 2_000, // Rs 20/piece
      })
      .returning({ id: schema.inventoryItems.id });
    const [cheese] = await db
      .insert(schema.inventoryItems)
      .values({
        restaurantId,
        name: "TEST Cheese",
        unit: "kg",
        costPerUnitInPaisa: 80_000, // Rs 800/kg
      })
      .returning({ id: schema.inventoryItems.id });

    await db.insert(schema.recipeItems).values([
      // 1 whole bun per serving: 1000 milliunits of "piece".
      { restaurantId, menuItemId: burgerMenuItemId, inventoryItemId: bun.id, quantityPerServingMilliunits: 1000 },
      // 30g of cheese per serving: 30 milliunits of "kg" (1000 = 1kg).
      { restaurantId, menuItemId: burgerMenuItemId, inventoryItemId: cheese.id, quantityPerServingMilliunits: 30 },
    ]);
    // Expected cost per serving: 1 * 2_000 (bun) + (30/1000) * 80_000 (cheese, 2_400) = 4_400 paisa.

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        tableId: null,
        orderNumber: generateOrderNumber("UTC"),
        source: "pos",
        status: "completed",
        subtotalInPaisa: 60_000,
        taxInPaisa: 0,
        totalInPaisa: 60_000,
        placedAt: new Date("2026-07-03T10:00:00Z"),
      })
      .returning({ id: schema.orders.id });

    await db.insert(schema.orderItems).values([
      // 2 burgers sold: COGS = 2 * 4_400 = 8_800 paisa.
      {
        orderId: order.id,
        menuItemId: burgerMenuItemId,
        menuItemNameSnapshot: "TEST Recipe Burger",
        unitPriceInPaisa: 25_000,
        quantity: 2,
        lineSubtotalInPaisa: 50_000,
        lineTotalInPaisa: 50_000,
      },
      // 1 no-recipe item sold: contributes 0 to COGS, but counts toward
      // soldItemCount (not itemsWithRecipeCount) — the coverage signal.
      {
        orderId: order.id,
        menuItemId: noRecipeMenuItemId,
        menuItemNameSnapshot: "TEST No-Recipe Item",
        unitPriceInPaisa: 10_000,
        quantity: 1,
        lineSubtotalInPaisa: 10_000,
        lineTotalInPaisa: 10_000,
      },
    ]);
  });

  afterAll(async () => {
    // orderItems/orders cascade; recipeItems/inventoryItems/menuItems/
    // categories/branches all cascade off restaurants.
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("getCogsSummary computes recipe-derived cost and reports coverage honestly", async () => {
    const cogs = await reports.getCogsSummary(restaurantId, RANGE, TZ);
    // 2 burgers @ 4_400 paisa/serving = 8_800. The no-recipe item contributes 0.
    expect(cogs.cogsInPaisa).toBe(8_800);
    expect(cogs.soldItemCount).toBe(2); // burger + no-recipe item, distinct menu items sold
    expect(cogs.itemsWithRecipeCount).toBe(1); // only the burger has a recipe
  });

  it("getReportSummary surfaces cogsInPaisa/grossProfitInPaisa alongside netProfitInPaisa, kept separate", async () => {
    const summary = await reports.getReportSummary(restaurantId, RANGE, TZ);
    expect(summary.sales.revenueInPaisa).toBe(60_000);
    expect(summary.cogsInPaisa).toBe(8_800);
    expect(summary.grossProfitInPaisa).toBe(51_200); // 60_000 - 8_800
    expect(summary.grossMarginPercent).toBeCloseTo((51_200 / 60_000) * 100, 2);
    expect(summary.cogsCoverage).toEqual({ soldItemCount: 2, itemsWithRecipeCount: 1 });
    // netProfitInPaisa stays revenue-minus-expenses, unaffected by COGS —
    // no expenses recorded in this fixture, so it equals revenue exactly,
    // proving COGS was NOT folded into it.
    expect(summary.netProfitInPaisa).toBe(60_000);
  });

  it("a branch with no matching orders reports zero COGS, not an error", async () => {
    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Empty Branch", isMain: false })
      .returning({ id: schema.branches.id });
    const cogs = await reports.getCogsSummary(restaurantId, RANGE, TZ, otherBranch.id);
    expect(cogs).toEqual({ cogsInPaisa: 0, soldItemCount: 0, itemsWithRecipeCount: 0 });
  });
});
