/**
 * Gap-audit P1 fix (recipe costing) integration tests: variant-level recipe
 * scaling (menuVariants.recipeQuantityMultiplierBasisPoints) and addon-level
 * recipe linkage (addonRecipeItems), both plugged into
 * deductRecipeStockForOrder (src/lib/inventory.ts) and the COGS/margin
 * reporting in src/lib/reports.ts.
 *
 * Covers, per the audit's own acceptance list:
 *  1. A variant with a 2x quantity multiplier deducts double the base
 *     recipe's ingredients and costs double.
 *  2. An addon with its own recipe_items deducts its ingredients and adds
 *     to the order's COGS.
 *  3. An order combining a scaled variant + an addon produces the correct
 *     combined cost.
 *  4. A regression check: an existing base-item-only order (no variant
 *     scaling, no addon costing) is completely unaffected — same
 *     recipeCostInPaisa/stock-deduction math as before this fix.
 *  5. The "partial cost coverage" flag (getCogsSummary.itemsWithRecipeCount /
 *     getProductProfitability.hasFullCostCoverage) correctly stops flagging
 *     an addon-only-costed line as partial, while still flagging a
 *     genuinely uncosted one.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);
const TZ = "UTC";

describe.skipIf(!hasDb)("Variant/addon recipe costing (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let inventoryLib: typeof import("@/lib/inventory");
  let reports: typeof import("@/lib/reports");
  let generateOrderNumber: (timezone: string) => string;

  let restaurantId: string;
  let branchId: string;
  let categoryId: string;

  // Ingredients.
  let bunId: string; // piece, Rs 20/piece
  let cheeseId: string; // kg, Rs 800/kg

  // Base menu item WITH a recipe: 1 bun/serving (2_000 paisa/serving).
  let pizzaMenuItemId: string;
  let largeVariantId: string; // 2x multiplier
  let smallVariantId: string; // default 1x multiplier

  // Menu item with NO recipe at all — used to isolate addon-only costing.
  let noRecipeMenuItemId: string;

  // Addon WITH its own recipe: 250g cheese/selection (20_000 paisa/selection).
  let extraCheeseAddonId: string;
  // Addon with NO recipe defined — a genuinely costless choice, not a gap.
  let napkinAddonId: string;

  // Separate fixtures for the report-level (getCogsSummary/
  // getProductProfitability) describe block below, deliberately isolated
  // from the ones above: getProductProfitability groups by
  // menuItemNameSnapshot across the WHOLE date range, so reusing the same
  // name across multiple it() blocks in that range would silently sum
  // their costs together and break the hand-computed assertions. A fresh
  // name per item sidesteps that without narrowing the range per test.
  let reportPizzaMenuItemId: string;
  let reportLargeVariantId: string;
  let reportNoRecipeMenuItemId: string;
  let reportNothingMenuItemId: string;
  // getCogsSummary (unlike getProductProfitability) sums cost across EVERY
  // order in the date range, not grouped by item — a distinct name alone
  // doesn't isolate it from the deduction-only tests' own orders sharing
  // the same range. A dedicated branch does: every getCogsSummary/
  // getProductProfitability call in the report describe block below
  // passes this branchId, scoping the aggregate to only its own orders.
  let reportBranchId: string;

  const RANGE = { from: "2026-08-01", to: "2026-08-07" };

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    inventoryLib = await import("@/lib/inventory");
    reports = await import("@/lib/reports");
    generateOrderNumber = (await import("@/lib/orders")).generateOrderNumber;

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-var-addon-cost-${suffix}`, name: "TEST Variant/Addon Costing Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId, name: "TEST Variant/Addon Costing Category" })
      .returning({ id: schema.categories.id });
    categoryId = category.id;

    const [bun] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST VA Bun", unit: "piece", costPerUnitInPaisa: 2_000 })
      .returning({ id: schema.inventoryItems.id });
    bunId = bun.id;

    const [cheese] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST VA Cheese", unit: "kg", costPerUnitInPaisa: 80_000 })
      .returning({ id: schema.inventoryItems.id });
    cheeseId = cheese.id;

    const [pizza] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST VA Pizza", basePriceInPaisa: 30_000 })
      .returning({ id: schema.menuItems.id });
    pizzaMenuItemId = pizza.id;

    // 1 whole bun per serving: 1_000 milliunits of "piece" = 2_000 paisa/serving.
    await db
      .insert(schema.recipeItems)
      .values({ restaurantId, menuItemId: pizzaMenuItemId, inventoryItemId: bunId, quantityPerServingMilliunits: 1000 });

    const [large] = await db
      .insert(schema.menuVariants)
      .values({
        menuItemId: pizzaMenuItemId,
        name: "TEST Large",
        priceInPaisa: 40_000,
        recipeQuantityMultiplierBasisPoints: 20000, // 2x
      })
      .returning({ id: schema.menuVariants.id });
    largeVariantId = large.id;

    const [small] = await db
      .insert(schema.menuVariants)
      .values({
        menuItemId: pizzaMenuItemId,
        name: "TEST Small",
        priceInPaisa: 25_000,
        // Deliberately omitted — proves the column default (10000 = 1x)
        // reproduces pre-fix behavior for a variant that never sets it.
      })
      .returning({ id: schema.menuVariants.id });
    smallVariantId = small.id;

    const [noRecipeItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST VA No-Recipe Item", basePriceInPaisa: 10_000 })
      .returning({ id: schema.menuItems.id });
    noRecipeMenuItemId = noRecipeItem.id;

    const [extraCheeseAddon] = await db
      .insert(schema.menuAddons)
      .values({ menuItemId: pizzaMenuItemId, name: "TEST Extra Cheese", priceInPaisa: 5_000 })
      .returning({ id: schema.menuAddons.id });
    extraCheeseAddonId = extraCheeseAddon.id;

    // 250g of cheese per selection: 250 milliunits of "kg" = 20_000 paisa/selection.
    await db.insert(schema.addonRecipeItems).values({
      restaurantId,
      addonId: extraCheeseAddonId,
      inventoryItemId: cheeseId,
      quantityPerServingMilliunits: 250,
    });

    const [napkinAddon] = await db
      .insert(schema.menuAddons)
      .values({ menuItemId: pizzaMenuItemId, name: "TEST Napkin", priceInPaisa: 0 })
      .returning({ id: schema.menuAddons.id });
    napkinAddonId = napkinAddon.id;

    // --- report-level describe block fixtures (see the field comments above) ---
    const [reportPizza] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST VA Report Pizza", basePriceInPaisa: 30_000 })
      .returning({ id: schema.menuItems.id });
    reportPizzaMenuItemId = reportPizza.id;
    await db.insert(schema.recipeItems).values({
      restaurantId,
      menuItemId: reportPizzaMenuItemId,
      inventoryItemId: bunId,
      quantityPerServingMilliunits: 1000,
    });
    const [reportLarge] = await db
      .insert(schema.menuVariants)
      .values({
        menuItemId: reportPizzaMenuItemId,
        name: "TEST Report Large",
        priceInPaisa: 40_000,
        recipeQuantityMultiplierBasisPoints: 20000, // 2x
      })
      .returning({ id: schema.menuVariants.id });
    reportLargeVariantId = reportLarge.id;

    const [reportNoRecipeItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST VA Report No-Recipe Item", basePriceInPaisa: 10_000 })
      .returning({ id: schema.menuItems.id });
    reportNoRecipeMenuItemId = reportNoRecipeItem.id;

    const [reportNothingItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId, name: "TEST VA Report Nothing Item", basePriceInPaisa: 10_000 })
      .returning({ id: schema.menuItems.id });
    reportNothingMenuItemId = reportNothingItem.id;

    const [reportBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST VA Report Branch", isMain: false })
      .returning({ id: schema.branches.id });
    reportBranchId = reportBranch.id;
  });

  afterAll(async () => {
    // Same FK-ordering constraints as product-profitability.test.ts's own
    // teardown comment: recipeItems/addonRecipeItems reference
    // inventoryItemId with ON DELETE RESTRICT, and
    // deductRecipeStockForOrder's stock movements create branch-level rows
    // that also reference inventory items — clear the recipe tables and
    // inventory items explicitly before the restaurant cascade reaches
    // them.
    await db.delete(schema.recipeItems).where(eq(schema.recipeItems.restaurantId, restaurantId));
    await db.delete(schema.addonRecipeItems).where(eq(schema.addonRecipeItems.restaurantId, restaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function createCompletedOrder(placedAt: Date, orderBranchId: string = branchId) {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId: orderBranchId,
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

  async function sumDeductedMilliunits(orderId: string, inventoryItemId: string) {
    const rows = await db
      .select({ qty: schema.stockMovements.quantityDeltaMilliunits })
      .from(schema.stockMovements)
      .where(
        and(
          eq(schema.stockMovements.referenceId, orderId),
          eq(schema.stockMovements.inventoryItemId, inventoryItemId),
          eq(schema.stockMovements.type, "sale_deduction"),
        ),
      );
    return rows.reduce((sum, r) => sum + r.qty, 0);
  }

  it("a plain base-item-only order (no variant, no addon) is completely unaffected — regression check", async () => {
    const orderId = await createCompletedOrder(new Date("2026-08-02T10:00:00Z"));
    const [line] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: pizzaMenuItemId,
        menuItemNameSnapshot: "TEST VA Pizza",
        unitPriceInPaisa: 30_000,
        quantity: 3,
        lineSubtotalInPaisa: 90_000,
        lineTotalInPaisa: 90_000,
      })
      .returning();

    await db.transaction((tx) => inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }));

    const [after] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    // Exactly the pre-fix formula: 3 * 2_000 = 6_000, no scaling applied.
    expect(after.recipeCostInPaisa).toBe(6_000);

    const bunDeducted = await sumDeductedMilliunits(orderId, bunId);
    expect(bunDeducted).toBe(-3000); // 3 bun servings, 1_000 milliunits each
  });

  it("a variant with a 2x recipe quantity multiplier deducts double the base recipe's ingredients and costs double", async () => {
    const orderId = await createCompletedOrder(new Date("2026-08-02T11:00:00Z"));
    const [line] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: pizzaMenuItemId,
        menuItemNameSnapshot: "TEST VA Pizza",
        variantId: largeVariantId,
        variantNameSnapshot: "TEST Large",
        unitPriceInPaisa: 40_000,
        quantity: 2,
        lineSubtotalInPaisa: 80_000,
        lineTotalInPaisa: 80_000,
      })
      .returning();

    await db.transaction((tx) => inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }));

    const [after] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    // 2 servings * 2x multiplier * 2_000 paisa/serving = 8_000 — double the
    // 4_000 an unscaled (1x) recipe at this quantity would cost.
    expect(after.recipeCostInPaisa).toBe(8_000);

    const bunDeducted = await sumDeductedMilliunits(orderId, bunId);
    // 2 servings * 2x * 1_000 milliunits/serving = 4_000 — double the 2_000
    // an unscaled recipe would deduct for the same quantity sold.
    expect(bunDeducted).toBe(-4000);
  });

  it("a variant with the default (unset) multiplier behaves exactly like 1x — proves the column default reproduces pre-fix behavior", async () => {
    const orderId = await createCompletedOrder(new Date("2026-08-02T12:00:00Z"));
    const [line] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: pizzaMenuItemId,
        menuItemNameSnapshot: "TEST VA Pizza",
        variantId: smallVariantId,
        variantNameSnapshot: "TEST Small",
        unitPriceInPaisa: 25_000,
        quantity: 4,
        lineSubtotalInPaisa: 100_000,
        lineTotalInPaisa: 100_000,
      })
      .returning();

    await db.transaction((tx) => inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }));

    const [after] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    expect(after.recipeCostInPaisa).toBe(8_000); // 4 * 1 * 2_000, unscaled
  });

  it("an addon with its own recipe_items deducts its ingredients and adds to the order's COGS, even when the base item has NO recipe", async () => {
    const orderId = await createCompletedOrder(new Date("2026-08-03T10:00:00Z"));
    const [line] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: noRecipeMenuItemId,
        menuItemNameSnapshot: "TEST VA No-Recipe Item",
        unitPriceInPaisa: 10_000,
        quantity: 2,
        lineSubtotalInPaisa: 20_000,
        addonsTotalInPaisa: 10_000,
        lineTotalInPaisa: 30_000,
      })
      .returning();
    await db.insert(schema.orderItemAddons).values({
      orderItemId: line.id,
      addonId: extraCheeseAddonId,
      nameSnapshot: "TEST Extra Cheese",
      priceInPaisaSnapshot: 5_000,
    });

    await db.transaction((tx) => inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }));

    const [after] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    // No base recipe at all — cost comes ENTIRELY from the addon:
    // 2 units sold * 20_000 paisa/selection = 40_000. NOT null, even
    // though the base item itself has no recipe.
    expect(after.recipeCostInPaisa).toBe(40_000);

    const cheeseDeducted = await sumDeductedMilliunits(orderId, cheeseId);
    expect(cheeseDeducted).toBe(-500); // 2 units * 250 milliunits/selection
  });

  it("a costless addon (no recipe defined) contributes 0 and does NOT block a line's cost from being marked known", async () => {
    const orderId = await createCompletedOrder(new Date("2026-08-03T11:00:00Z"));
    const [line] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: pizzaMenuItemId,
        menuItemNameSnapshot: "TEST VA Pizza",
        unitPriceInPaisa: 30_000,
        quantity: 1,
        lineSubtotalInPaisa: 30_000,
        lineTotalInPaisa: 30_000,
      })
      .returning();
    await db.insert(schema.orderItemAddons).values({
      orderItemId: line.id,
      addonId: napkinAddonId,
      nameSnapshot: "TEST Napkin",
      priceInPaisaSnapshot: 0,
    });

    await db.transaction((tx) => inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }));

    const [after] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    // Base recipe cost only (1 * 2_000) — the costless napkin adds 0, and
    // does not turn this into an "unknown" line.
    expect(after.recipeCostInPaisa).toBe(2_000);
  });

  it("an order combining a scaled variant + a costed addon produces the correct COMBINED cost and deductions", async () => {
    const orderId = await createCompletedOrder(new Date("2026-08-04T10:00:00Z"));
    const [line] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: pizzaMenuItemId,
        menuItemNameSnapshot: "TEST VA Pizza",
        variantId: largeVariantId,
        variantNameSnapshot: "TEST Large",
        unitPriceInPaisa: 40_000,
        quantity: 2,
        lineSubtotalInPaisa: 80_000,
        addonsTotalInPaisa: 10_000,
        lineTotalInPaisa: 90_000,
      })
      .returning();
    await db.insert(schema.orderItemAddons).values({
      orderItemId: line.id,
      addonId: extraCheeseAddonId,
      nameSnapshot: "TEST Extra Cheese",
      priceInPaisaSnapshot: 5_000,
    });

    await db.transaction((tx) => inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }));

    const [after] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    // Base (variant-scaled): 2 servings * 2x * 2_000 = 8_000.
    // Addon (NOT scaled by the variant multiplier): 2 units * 20_000 = 40_000.
    // Combined: 48_000.
    expect(after.recipeCostInPaisa).toBe(48_000);

    const bunDeducted = await sumDeductedMilliunits(orderId, bunId);
    expect(bunDeducted).toBe(-4000); // 2 * 2x * 1_000
    const cheeseDeducted = await sumDeductedMilliunits(orderId, cheeseId);
    expect(cheeseDeducted).toBe(-500); // 2 * 250, addon unaffected by variant multiplier
  });

  it("an item with NEITHER a base recipe NOR any costed addon still leaves recipeCostInPaisa NULL — genuinely unknown, not silently zero", async () => {
    const orderId = await createCompletedOrder(new Date("2026-08-05T10:00:00Z"));
    const [line] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemId: noRecipeMenuItemId,
        menuItemNameSnapshot: "TEST VA No-Recipe Item",
        unitPriceInPaisa: 10_000,
        quantity: 1,
        lineSubtotalInPaisa: 10_000,
        lineTotalInPaisa: 10_000,
      })
      .returning();

    await db.transaction((tx) => inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId, orderId }));

    const [after] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    expect(after.recipeCostInPaisa).toBeNull();
  });

  describe("COGS/profitability reporting reflects variant/addon costing and the coverage flag stops flagging addon-only lines as partial", () => {
    it("getCogsSummary sums the variant-scaled + addon-inclusive cost, and marks an addon-only-costed item as covered", async () => {
      const orderId = await createCompletedOrder(new Date("2026-08-06T10:00:00Z"), reportBranchId);

      // Line A: scaled variant (2x), no addon. Cost = 2 * 2 * 2_000 = 8_000.
      await db.insert(schema.orderItems).values({
        orderId,
        menuItemId: reportPizzaMenuItemId,
        menuItemNameSnapshot: "TEST VA Report Pizza",
        variantId: reportLargeVariantId,
        variantNameSnapshot: "TEST Report Large",
        unitPriceInPaisa: 40_000,
        quantity: 2,
        lineSubtotalInPaisa: 80_000,
        lineTotalInPaisa: 80_000,
      });

      // Line B: base item with NO recipe, but a costed addon. Cost is
      // entirely from the addon: 1 * 20_000 = 20_000. Previously this line
      // would have been reported as fully uncosted/partial (no base
      // recipe existed) — now it should count as covered.
      const [lineB] = await db
        .insert(schema.orderItems)
        .values({
          orderId,
          menuItemId: reportNoRecipeMenuItemId,
          menuItemNameSnapshot: "TEST VA Report No-Recipe Item",
          unitPriceInPaisa: 10_000,
          quantity: 1,
          lineSubtotalInPaisa: 10_000,
          addonsTotalInPaisa: 5_000,
          lineTotalInPaisa: 15_000,
        })
        .returning();
      await db.insert(schema.orderItemAddons).values({
        orderItemId: lineB.id,
        addonId: extraCheeseAddonId,
        nameSnapshot: "TEST Extra Cheese",
        priceInPaisaSnapshot: 5_000,
      });

      await db.transaction((tx) =>
        inventoryLib.deductRecipeStockForOrder(tx, { restaurantId, branchId: reportBranchId, orderId }),
      );

      const cogs = await reports.getCogsSummary(restaurantId, RANGE, TZ, reportBranchId);
      expect(cogs.cogsInPaisa).toBe(28_000); // 8_000 + 20_000
      expect(cogs.soldItemCount).toBe(2); // report pizza + report no-recipe item, distinct
      // BOTH items now count as "covered": the pizza has a real (scaled)
      // base recipe, and the no-recipe item is fully costed through its
      // addon — this is the gap-audit fix: previously only the pizza
      // would have counted here.
      expect(cogs.itemsWithRecipeCount).toBe(2);

      const profitability = await reports.getProductProfitability(restaurantId, RANGE, TZ, reportBranchId);
      const pizzaRow = profitability.find((r) => r.name === "TEST VA Report Pizza");
      const noRecipeRow = profitability.find((r) => r.name === "TEST VA Report No-Recipe Item");
      expect(pizzaRow?.cogsInPaisa).toBe(8_000);
      expect(pizzaRow?.hasFullCostCoverage).toBe(true);
      expect(noRecipeRow?.cogsInPaisa).toBe(20_000);
      // The gap-audit fix in action: addon-only costing is no longer
      // flagged as partial coverage.
      expect(noRecipeRow?.hasFullCostCoverage).toBe(true);
    });

    it("an item with genuinely no cost source anywhere is still flagged as partial coverage", async () => {
      const orderId = await createCompletedOrder(new Date("2026-08-06T11:00:00Z"));
      await db.insert(schema.orderItems).values({
        orderId,
        menuItemId: reportNothingMenuItemId,
        menuItemNameSnapshot: "TEST VA Report Nothing Item",
        unitPriceInPaisa: 10_000,
        quantity: 1,
        lineSubtotalInPaisa: 10_000,
        lineTotalInPaisa: 10_000,
      });
      // Deliberately NOT calling deductRecipeStockForOrder — this proves
      // the LIVE fallback path (no frozen snapshot yet) still correctly
      // reports "no cost source" as partial, not silently covered.

      const profitability = await reports.getProductProfitability(restaurantId, RANGE, TZ, branchId);
      const row = profitability.find((r) => r.name === "TEST VA Report Nothing Item");
      expect(row?.cogsInPaisa).toBe(0);
      expect(row?.hasFullCostCoverage).toBe(false);
    });
  });
});
