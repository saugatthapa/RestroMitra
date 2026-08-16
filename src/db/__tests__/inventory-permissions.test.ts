/**
 * Phase 7 integration test: proves (a) inventory access is properly
 * tenant-isolated at the lib layer — recordStockMovement refuses to touch
 * an inventory item that doesn't belong to the restaurant it's told to
 * scope to, even if the item id itself is valid, (b) the weighted-average
 * purchase costing formula in applyPurchaseCosting matches hand-computed
 * expected values across two purchases, (c) deductRecipeStockForOrder
 * correctly fans a single order's line items out across each item's
 * recipe and deducts the right multiples, skipping items with no recipe
 * or no menuItemId, and (d) the non-throwing hasPermission() helper
 * agrees with the seeded inventory_manager/waiter role_permissions data.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Inventory ledger, costing, recipe deduction (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");
  let inventoryLib: typeof import("@/lib/inventory");

  let ownerAId: string;
  let inventoryManagerAId: string;
  let waiterAId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let branchAId: string;
  let categoryId: string;
  let menuItemId: string;
  let flourItemId: string; // restaurant A
  let sugarItemId: string; // restaurant A, no recipe usage
  let otherRestaurantItemId: string; // restaurant B

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");
    inventoryLib = await import("@/lib/inventory");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Inv Owner A", phone: `9725${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [inventoryManagerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Inv Manager A", phone: `9726${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [waiterA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Inv Waiter A", phone: `9727${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    inventoryManagerAId = inventoryManagerA.id;
    waiterAId = waiterA.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-inv-a-${suffix}`, name: "TEST Inventory Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-inv-b-${suffix}`, name: "TEST Inventory Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerAId, restaurantId: restaurantAId, role: "owner" },
      { userId: inventoryManagerAId, restaurantId: restaurantAId, role: "inventory_manager" },
      { userId: waiterAId, restaurantId: restaurantAId, role: "waiter" },
    ]);

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId: restaurantAId, name: "TEST Category" })
      .returning({ id: schema.categories.id });
    categoryId = category.id;

    const [menuItem] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId: restaurantAId,
        categoryId,
        name: "TEST Momo Plate",
        basePriceInPaisa: 18_000,
      })
      .returning({ id: schema.menuItems.id });
    menuItemId = menuItem.id;

    const [flour] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId: restaurantAId, name: "TEST Flour", unit: "kg" })
      .returning({ id: schema.inventoryItems.id });
    const [sugar] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId: restaurantAId, name: "TEST Sugar", unit: "kg" })
      .returning({ id: schema.inventoryItems.id });
    flourItemId = flour.id;
    sugarItemId = sugar.id;

    const [otherItem] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId: restaurantBId, name: "TEST Rice (restaurant B)", unit: "kg" })
      .returning({ id: schema.inventoryItems.id });
    otherRestaurantItemId = otherItem.id;

    // Recipe: one serving of the Momo Plate consumes 0.2 kg of flour. Sugar
    // is deliberately NOT part of any recipe, to prove unused items are
    // left alone by deductRecipeStockForOrder.
    await db.insert(schema.recipeItems).values({
      restaurantId: restaurantAId,
      menuItemId,
      inventoryItemId: flourItemId,
      quantityPerServingMilliunits: 200,
    });
  });

  afterAll(async () => {
    await db.delete(schema.orderItems).where(eq(schema.orderItems.menuItemId, menuItemId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantAId));
    await db.delete(schema.recipeItems).where(eq(schema.recipeItems.restaurantId, restaurantAId));
    await db.delete(schema.stockMovements).where(eq(schema.stockMovements.restaurantId, restaurantAId));
    await db.delete(schema.purchaseItems).where(eq(schema.purchaseItems.inventoryItemId, flourItemId));
    await db.delete(schema.purchases).where(eq(schema.purchases.restaurantId, restaurantAId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantAId));
    await db.delete(schema.stockMovements).where(eq(schema.stockMovements.restaurantId, restaurantBId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantBId));
    await db.delete(schema.menuItems).where(eq(schema.menuItems.restaurantId, restaurantAId));
    await db.delete(schema.categories).where(eq(schema.categories.restaurantId, restaurantAId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerAId));
    await db.delete(schema.users).where(eq(schema.users.id, inventoryManagerAId));
    await db.delete(schema.users).where(eq(schema.users.id, waiterAId));
  });

  it("hasPermission agrees with the seeded role matrix: inventory_manager has MANAGE_INVENTORY, waiter does not", async () => {
    await expect(
      guard.hasPermission(inventoryManagerAId, restaurantAId, PERMISSIONS.MANAGE_INVENTORY),
    ).resolves.toBe(true);
    await expect(
      guard.hasPermission(waiterAId, restaurantAId, PERMISSIONS.MANAGE_INVENTORY),
    ).resolves.toBe(false);
  });

  it("hasPermission never throws, unlike requirePermission, for a denied check", async () => {
    await expect(
      guard.requirePermission(waiterAId, restaurantAId, PERMISSIONS.MANAGE_INVENTORY),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      guard.hasPermission(waiterAId, restaurantAId, PERMISSIONS.MANAGE_INVENTORY),
    ).resolves.toBe(false);
  });

  it("recordStockMovement refuses to move stock for an item belonging to a different restaurant", async () => {
    await expect(
      db.transaction((tx) =>
        inventoryLib.recordStockMovement(tx, {
          restaurantId: restaurantAId,
          inventoryItemId: otherRestaurantItemId, // belongs to restaurant B
          type: "adjustment",
          quantityDeltaMilliunits: 1000,
          note: "TEST cross-tenant attempt",
        }),
      ),
    ).rejects.toThrow(inventoryLib.InventoryError);

    // And the whole transaction rolled back — no stray movement row.
    const rows = await db
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.inventoryItemId, otherRestaurantItemId));
    expect(rows).toHaveLength(0);
  });

  it("recordStockMovement rejects a zero-quantity delta", async () => {
    await expect(
      db.transaction((tx) =>
        inventoryLib.recordStockMovement(tx, {
          restaurantId: restaurantAId,
          inventoryItemId: flourItemId,
          type: "adjustment",
          quantityDeltaMilliunits: 0,
          note: "TEST zero delta",
        }),
      ),
    ).rejects.toThrow(inventoryLib.InventoryError);
  });

  it("recordStockMovement atomically increments the cached stock and inserts a ledger row", async () => {
    const result = await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: restaurantAId,
        inventoryItemId: sugarItemId,
        type: "adjustment",
        quantityDeltaMilliunits: 5000, // +5kg
        note: "TEST initial count",
        recordedByUserId: inventoryManagerAId,
      }),
    );
    expect(result.item.currentStockMilliunits).toBe(5000);
    expect(result.movement.quantityDeltaMilliunits).toBe(5000);
    expect(result.movement.type).toBe("adjustment");

    const second = await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId: restaurantAId,
        inventoryItemId: sugarItemId,
        type: "sale_deduction",
        quantityDeltaMilliunits: -1200, // -1.2kg
        note: "TEST usage",
      }),
    );
    expect(second.item.currentStockMilliunits).toBe(3800);
  });

  it("applyPurchaseCosting computes a weighted average across two purchases, matching hand-computed values", async () => {
    // Purchase 1: 5kg flour @ Rs 200/kg (20000 paisa). Starting stock/cost
    // are both zero, so the new cost is simply the purchase's unit cost.
    const purchase1 = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(schema.purchases)
        .values({ restaurantId: restaurantAId, totalInPaisa: 100_000 })
        .returning();
      await inventoryLib.applyPurchaseCosting(tx, {
        restaurantId: restaurantAId,
        inventoryItemId: flourItemId,
        purchasedQuantityMilliunits: 5000,
        unitCostInPaisa: 20_000,
        purchaseId: p.id,
      });
      return p;
    });

    const afterFirst = await db
      .select()
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, flourItemId));
    expect(afterFirst[0].costPerUnitInPaisa).toBe(20_000);
    expect(afterFirst[0].currentStockMilliunits).toBe(5000);

    // Purchase 2: 5kg flour @ Rs 300/kg (30000 paisa). Weighted average:
    // (5000*20000 + 5000*30000) / 10000 = 25000 paisa (Rs 250/kg).
    await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(schema.purchases)
        .values({ restaurantId: restaurantAId, totalInPaisa: 150_000 })
        .returning();
      await inventoryLib.applyPurchaseCosting(tx, {
        restaurantId: restaurantAId,
        inventoryItemId: flourItemId,
        purchasedQuantityMilliunits: 5000,
        unitCostInPaisa: 30_000,
        purchaseId: p.id,
      });
      return p;
    });

    const afterSecond = await db
      .select()
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, flourItemId));
    expect(afterSecond[0].costPerUnitInPaisa).toBe(25_000);
    expect(afterSecond[0].currentStockMilliunits).toBe(10_000);

    void purchase1;
  });

  it("deductRecipeStockForOrder deducts exactly quantityPerServing * order quantity for each recipe line, skipping items with no recipe", async () => {
    // Reset flour to a known 10kg baseline for a clean assertion.
    await db
      .update(schema.inventoryItems)
      .set({ currentStockMilliunits: 10_000 })
      .where(eq(schema.inventoryItems.id, flourItemId));

    const sugarBefore = await db
      .select({ currentStockMilliunits: schema.inventoryItems.currentStockMilliunits })
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, sugarItemId));

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: restaurantAId,
        branchId: branchAId,
        orderNumber: `TEST-INV-${Math.random().toString(36).slice(2, 8)}`,
        source: "pos",
        status: "confirmed",
        subtotalInPaisa: 54_000,
        taxInPaisa: 0,
        totalInPaisa: 54_000,
      })
      .returning();

    // 3 servings of the Momo Plate (has a flour recipe), plus one line item
    // with no menuItemId at all (as if the menu item was later deleted) —
    // deductRecipeStockForOrder must skip that line without erroring.
    await db.insert(schema.orderItems).values([
      {
        orderId: order.id,
        menuItemId,
        menuItemNameSnapshot: "TEST Momo Plate",
        unitPriceInPaisa: 18_000,
        quantity: 3,
        lineSubtotalInPaisa: 54_000,
        lineTotalInPaisa: 54_000,
      },
      {
        orderId: order.id,
        menuItemId: null,
        menuItemNameSnapshot: "TEST Deleted Item",
        unitPriceInPaisa: 10_000,
        quantity: 1,
        lineSubtotalInPaisa: 10_000,
        lineTotalInPaisa: 10_000,
      },
    ]);

    await db.transaction((tx) =>
      inventoryLib.deductRecipeStockForOrder(tx, {
        restaurantId: restaurantAId,
        orderId: order.id,
        recordedByUserId: inventoryManagerAId,
      }),
    );

    const flourAfter = await db
      .select()
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, flourItemId));
    // 0.2kg/serving * 3 servings = 0.6kg = 600 milliunits deducted.
    expect(flourAfter[0].currentStockMilliunits).toBe(10_000 - 600);

    const movements = await db
      .select()
      .from(schema.stockMovements)
      .where(
        and(
          eq(schema.stockMovements.inventoryItemId, flourItemId),
          eq(schema.stockMovements.referenceId, order.id),
        ),
      );
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe("sale_deduction");
    expect(movements[0].quantityDeltaMilliunits).toBe(-600);
    expect(movements[0].referenceType).toBe("order");

    // Sugar has no recipe line for this menu item — untouched.
    const sugarAfter = await db
      .select({ currentStockMilliunits: schema.inventoryItems.currentStockMilliunits })
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, sugarItemId));
    expect(sugarAfter[0].currentStockMilliunits).toBe(sugarBefore[0].currentStockMilliunits);
  });
});
