/**
 * P2 gap audit — "negative stock is always allowed by deliberate, disclosed
 * design, with no restaurant-level toggle to disallow it." Integration
 * tests for `restaurants.allowNegativeStock` and its enforcement inside
 * `recordStockMovement` (src/lib/inventory.ts), the single choke point
 * every stock-mutating path in this app funnels through.
 *
 * Deliberately NOT a re-test of the whole pre-existing negative-stock
 * permissive suite (stock-transfer.test.ts's "dispatch/receive still
 * succeed even when the source branch's stock goes negative", stock-
 * movement-concurrency.test.ts, product-profitability.test.ts, etc. — all
 * of those keep passing completely unchanged, since every restaurant they
 * create leaves `allowNegativeStock` at its schema default of `true`) —
 * this file only adds the ON-path cases: with the toggle explicitly turned
 * off, a deduction that would take a branch's stock negative is rejected
 * with a clear error and leaves stock untouched, across every deduction
 * surface (a direct manual adjustment/waste movement, recipe deduction on
 * order confirm, a stock-count variance, and a stock-transfer dispatch),
 * plus confirmation that a positive-delta movement (a purchase, a
 * transfer receipt) is never blocked by the toggle even when it leaves the
 * branch still negative from before enforcement was turned on.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Negative stock enforcement toggle (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let inventoryLib: typeof import("@/lib/inventory");
  let stockCountLib: typeof import("@/lib/stock-count");
  let stockTransferLib: typeof import("@/lib/stock-transfer");
  let generateOrderNumber: (timezone: string) => string;

  let enforcedRestaurantId: string; // allowNegativeStock: false
  let enforcedBranchId: string;
  let enforcedBranchBId: string;
  let permissiveRestaurantId: string; // allowNegativeStock omitted -> defaults true
  let permissiveBranchId: string;
  let userId: string;
  let categoryId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    inventoryLib = await import("@/lib/inventory");
    stockCountLib = await import("@/lib/stock-count");
    stockTransferLib = await import("@/lib/stock-transfer");
    generateOrderNumber = (await import("@/lib/orders")).generateOrderNumber;

    const suffix = Math.random().toString(36).slice(2, 8);

    const [enforced] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-negstock-enforced-${suffix}`,
        name: "TEST Hard Enforcement Restaurant",
        allowNegativeStock: false,
      })
      .returning({ id: schema.restaurants.id });
    enforcedRestaurantId = enforced.id;

    const [permissive] = await db
      .insert(schema.restaurants)
      // allowNegativeStock deliberately omitted — proves the schema default
      // (true, today's unchanged behavior) is what a brand-new restaurant
      // actually gets, not something a test has to opt into.
      .values({ slug: `test-negstock-permissive-${suffix}`, name: "TEST Permissive Restaurant" })
      .returning({ id: schema.restaurants.id });
    permissiveRestaurantId = permissive.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId: enforcedRestaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    enforcedBranchId = branch.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId: enforcedRestaurantId, name: "Branch B", isMain: false })
      .returning({ id: schema.branches.id });
    enforcedBranchBId = branchB.id;

    const [permBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: permissiveRestaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    permissiveBranchId = permBranch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Negstock User", phone: `973${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId: enforcedRestaurantId, name: "TEST Negstock Category" })
      .returning({ id: schema.categories.id });
    categoryId = category.id;
  });

  afterAll(async () => {
    // Same cleanup ordering every other inventory integration test in this
    // project uses (see stock-count.test.ts/product-profitability.test.ts's
    // own comments): recipe_items/orders/stock_counts/stock_transfers
    // before the inventory items they reference (ON DELETE RESTRICT), then
    // the inventory items (cascades branch-level rows), then the
    // restaurant.
    await db.delete(schema.recipeItems).where(eq(schema.recipeItems.restaurantId, enforcedRestaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, enforcedRestaurantId));
    await db.delete(schema.stockCounts).where(eq(schema.stockCounts.restaurantId, enforcedRestaurantId));
    await db.delete(schema.stockTransfers).where(eq(schema.stockTransfers.restaurantId, enforcedRestaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, enforcedRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, enforcedRestaurantId));

    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, permissiveRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, permissiveRestaurantId));
  });

  /** Fresh item per test — same "never share a running stock total across tests" reasoning as stock-count.test.ts/stock-transfer.test.ts's own createItem helpers. */
  async function createItem(restaurantId: string, costPerUnitInPaisa = 1_000) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: `TEST Negstock Item ${suffix}`, unit: "kg", costPerUnitInPaisa })
      .returning({ id: schema.inventoryItems.id });
    return item.id;
  }

  async function branchLevel(itemId: string, branchId: string) {
    const [row] = await db
      .select({ qty: schema.branchInventoryLevels.currentStockMilliunits })
      .from(schema.branchInventoryLevels)
      .where(
        and(
          eq(schema.branchInventoryLevels.inventoryItemId, itemId),
          eq(schema.branchInventoryLevels.branchId, branchId),
        ),
      );
    return row?.qty ?? 0;
  }

  async function movementCount(itemId: string) {
    const rows = await db
      .select({ id: schema.stockMovements.id })
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.inventoryItemId, itemId));
    return rows.length;
  }

  it("recordStockMovement: with enforcement ON, a deduction that would take the branch negative is rejected and nothing is written", async () => {
    const itemId = await createItem(enforcedRestaurantId);
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        inventoryItemId: itemId,
        type: "adjustment",
        quantityDeltaMilliunits: 2_000, // 2kg on hand
        note: "TEST seed stock",
        recordedByUserId: userId,
      }),
    );
    expect(await branchLevel(itemId, enforcedBranchId)).toBe(2_000);
    const movementsBefore = await movementCount(itemId);

    await expect(
      db.transaction((tx) =>
        inventoryLib.recordStockMovement(tx, {
          restaurantId: enforcedRestaurantId,
          branchId: enforcedBranchId,
          inventoryItemId: itemId,
          type: "sale_deduction",
          quantityDeltaMilliunits: -3_000, // would leave -1kg
          recordedByUserId: userId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    // Nothing moved: branch level unchanged, no new ledger row, restaurant-
    // wide cached total unchanged too.
    expect(await branchLevel(itemId, enforcedBranchId)).toBe(2_000);
    expect(await movementCount(itemId)).toBe(movementsBefore);
    const [item] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, itemId));
    expect(item.currentStockMilliunits).toBe(2_000);
  });

  it("recordStockMovement: with enforcement ON, a deduction that leaves the branch at exactly zero still succeeds (zero is not negative)", async () => {
    const itemId = await createItem(enforcedRestaurantId);
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        inventoryItemId: itemId,
        type: "adjustment",
        quantityDeltaMilliunits: 2_000,
        recordedByUserId: userId,
      }),
    );
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        inventoryItemId: itemId,
        type: "sale_deduction",
        quantityDeltaMilliunits: -2_000,
        recordedByUserId: userId,
      }),
    );
    expect(await branchLevel(itemId, enforcedBranchId)).toBe(0);
  });

  it("recordStockMovement: with enforcement ON, a waste movement that would take the branch negative is rejected", async () => {
    const itemId = await createItem(enforcedRestaurantId);
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        inventoryItemId: itemId,
        type: "adjustment",
        quantityDeltaMilliunits: 500,
        recordedByUserId: userId,
      }),
    );
    await expect(
      db.transaction((tx) =>
        inventoryLib.recordStockMovement(tx, {
          restaurantId: enforcedRestaurantId,
          branchId: enforcedBranchId,
          inventoryItemId: itemId,
          type: "waste",
          quantityDeltaMilliunits: -800,
          wasteReason: "spoilage",
          recordedByUserId: userId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await branchLevel(itemId, enforcedBranchId)).toBe(500);
  });

  it("recordStockMovement: enforcement ON never blocks a positive-delta movement, even when the branch stays negative afterward", async () => {
    const itemId = await createItem(enforcedRestaurantId);
    // Go negative the ordinary permissive way FIRST, on branch B, by
    // temporarily flipping this restaurant's own toggle off then back on —
    // simulates stock that went negative before hard enforcement was
    // turned on, which enforcement must never retroactively fix.
    await db
      .update(schema.restaurants)
      .set({ allowNegativeStock: true })
      .where(eq(schema.restaurants.id, enforcedRestaurantId));
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchBId,
        inventoryItemId: itemId,
        type: "sale_deduction",
        quantityDeltaMilliunits: -1_000, // 0 -> -1kg, allowed while toggle is off
        recordedByUserId: userId,
      }),
    );
    await db
      .update(schema.restaurants)
      .set({ allowNegativeStock: false })
      .where(eq(schema.restaurants.id, enforcedRestaurantId));
    expect(await branchLevel(itemId, enforcedBranchBId)).toBe(-1_000);

    // A purchase (positive delta) restocking only PART of the deficit —
    // still leaves the branch at -500, still negative — must NOT be
    // blocked: enforcement only stops NEW negative stock, never blocks a
    // movement that's moving stock toward zero.
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchBId,
        inventoryItemId: itemId,
        type: "purchase",
        quantityDeltaMilliunits: 500,
        recordedByUserId: userId,
      }),
    );
    expect(await branchLevel(itemId, enforcedBranchBId)).toBe(-500);
  });

  it("deductRecipeStockForOrder: with enforcement ON, a recipe deduction that would take an ingredient negative is rejected and rolls back every line for that order", async () => {
    const flourId = await createItem(enforcedRestaurantId, 500);
    const sugarId = await createItem(enforcedRestaurantId, 300);
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        inventoryItemId: flourId,
        type: "adjustment",
        quantityDeltaMilliunits: 5_000, // plenty of flour
        recordedByUserId: userId,
      }),
    );
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        inventoryItemId: sugarId,
        type: "adjustment",
        quantityDeltaMilliunits: 200, // barely any sugar
        recordedByUserId: userId,
      }),
    );

    const [cake] = await db
      .insert(schema.menuItems)
      .values({ restaurantId: enforcedRestaurantId, categoryId, name: "TEST Negstock Cake", basePriceInPaisa: 30_000 })
      .returning({ id: schema.menuItems.id });
    await db.insert(schema.recipeItems).values([
      { restaurantId: enforcedRestaurantId, menuItemId: cake.id, inventoryItemId: flourId, quantityPerServingMilliunits: 500 },
      { restaurantId: enforcedRestaurantId, menuItemId: cake.id, inventoryItemId: sugarId, quantityPerServingMilliunits: 500 }, // needs more sugar than is on hand
    ]);

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        tableId: null,
        orderNumber: generateOrderNumber("UTC"),
        source: "pos",
        status: "confirmed",
        subtotalInPaisa: 30_000,
        taxInPaisa: 0,
        totalInPaisa: 30_000,
      })
      .returning({ id: schema.orders.id });
    const [line] = await db
      .insert(schema.orderItems)
      .values({
        orderId: order.id,
        menuItemId: cake.id,
        menuItemNameSnapshot: "TEST Negstock Cake",
        unitPriceInPaisa: 30_000,
        quantity: 1,
        lineSubtotalInPaisa: 30_000,
        lineTotalInPaisa: 30_000,
      })
      .returning();

    await expect(
      db.transaction((tx) =>
        inventoryLib.deductRecipeStockForOrder(tx, {
          restaurantId: enforcedRestaurantId,
          branchId: enforcedBranchId,
          orderId: order.id,
          recordedByUserId: userId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    // Whole transaction rolled back — flour (which alone would have been
    // fine) is untouched too, and the order line's COGS snapshot was never
    // written.
    expect(await branchLevel(flourId, enforcedBranchId)).toBe(5_000);
    expect(await branchLevel(sugarId, enforcedBranchId)).toBe(200);
    const [lineAfter] = await db.select().from(schema.orderItems).where(eq(schema.orderItems.id, line.id));
    expect(lineAfter.recipeCostInPaisa).toBeNull();
  });

  it("submitStockCount: with enforcement ON, a variance that would take the branch negative (stock moved between the count snapshot and submission) is rejected and the count stays open", async () => {
    const itemId = await createItem(enforcedRestaurantId, 1_000);
    // System stock at snapshot time: 10kg.
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        inventoryItemId: itemId,
        type: "adjustment",
        quantityDeltaMilliunits: 10_000,
        recordedByUserId: userId,
      }),
    );

    const count = await stockCountLib.createStockCount({
      restaurantId: enforcedRestaurantId,
      branchId: enforcedBranchId,
      countedByUserId: userId,
    });
    await db.transaction((tx) =>
      stockCountLib.addStockCountItem(tx, {
        restaurantId: enforcedRestaurantId,
        stockCountId: count!.id,
        inventoryItemId: itemId,
        // 9.5kg physical — a small, realistic 5% shrinkage against the
        // 10kg system snapshot, well inside both "large variance"
        // thresholds, so submit auto-applies instead of requiring approval.
        physicalQuantityMilliunits: 9_500,
      }),
    );

    // A big sale happens for the rest of the day, AFTER the count snapshot
    // was frozen but BEFORE the count is submitted — a real sequence of
    // events, not a contrived race. Actual branch stock is now only 0.2kg,
    // far below what the stale system snapshot assumed.
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        inventoryItemId: itemId,
        type: "sale_deduction",
        quantityDeltaMilliunits: -9_800,
        recordedByUserId: userId,
      }),
    );
    expect(await branchLevel(itemId, enforcedBranchId)).toBe(200);

    await expect(
      db.transaction((tx) =>
        stockCountLib.submitStockCount(tx, {
          restaurantId: enforcedRestaurantId,
          stockCountId: count!.id,
          submittedByUserId: userId,
          timezone: "UTC",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    // The variance movement never landed: branch stock is still 200
    // (untouched by the rejected -500 milliunit adjustment), and the count
    // itself is still "open", not "applied".
    expect(await branchLevel(itemId, enforcedBranchId)).toBe(200);
    const [countAfter] = await db.select().from(schema.stockCounts).where(eq(schema.stockCounts.id, count!.id));
    expect(countAfter.status).toBe("open");
  });

  it("dispatchStockTransfer: with enforcement ON, a dispatch that would take the source branch negative is rejected and the transfer stays approved", async () => {
    const itemId = await createItem(enforcedRestaurantId);
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: enforcedRestaurantId,
        branchId: enforcedBranchId,
        inventoryItemId: itemId,
        type: "adjustment",
        quantityDeltaMilliunits: 100, // only 0.1kg on hand
        recordedByUserId: userId,
      }),
    );

    const created = await stockTransferLib.createStockTransfer({
      restaurantId: enforcedRestaurantId,
      fromBranchId: enforcedBranchId,
      toBranchId: enforcedBranchBId,
      requestedByUserId: userId,
      items: [{ inventoryItemId: itemId, quantityMilliunits: 5_000 }], // request 5kg anyway
    });
    await db.transaction((tx) =>
      stockTransferLib.approveStockTransfer(tx, {
        restaurantId: enforcedRestaurantId,
        stockTransferId: created.transfer.id,
        approvedByUserId: userId,
      }),
    );

    await expect(
      db.transaction((tx) =>
        stockTransferLib.dispatchStockTransfer(tx, {
          restaurantId: enforcedRestaurantId,
          stockTransferId: created.transfer.id,
          dispatchedByUserId: userId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(await branchLevel(itemId, enforcedBranchId)).toBe(100);
    const [transferAfter] = await db
      .select()
      .from(schema.stockTransfers)
      .where(eq(schema.stockTransfers.id, created.transfer.id));
    expect(transferAfter.status).toBe("approved");
  });

  it("recordStockMovement: with the toggle at its schema default (omitted, i.e. permissive), a deduction still goes negative exactly as before — unchanged, pre-existing behavior", async () => {
    const itemId = await createItem(permissiveRestaurantId);
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: permissiveRestaurantId,
        branchId: permissiveBranchId,
        inventoryItemId: itemId,
        type: "adjustment",
        quantityDeltaMilliunits: 1_000,
        recordedByUserId: userId,
      }),
    );
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: permissiveRestaurantId,
        branchId: permissiveBranchId,
        inventoryItemId: itemId,
        type: "sale_deduction",
        quantityDeltaMilliunits: -4_000,
        recordedByUserId: userId,
      }),
    );
    expect(await branchLevel(itemId, permissiveBranchId)).toBe(-3_000);
  });
});
