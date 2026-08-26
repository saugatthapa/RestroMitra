/**
 * Commercial-launch Phase A.6 (Physical Stock Count) integration tests for
 * src/lib/stock-count.ts — createStockCount/addStockCountItem/
 * setStockCountItemPhysicalQuantity/submitStockCount/approveStockCount/
 * rejectStockCount/getStockCountDetail/listStockCounts.
 *
 * Same convention as supplier-dues.test.ts (see its own doc comment): RBAC/
 * tenant/branch scoping for resolveRestaurantContext()/requireBranchAccess()
 * is covered by rbac/guard's own tests, so this file exercises the business
 * logic directly — variance computation/thresholds, the
 * open -> (submit) -> applied | pending_approval -> approved|rejected state
 * machine, tenant/branch isolation, validation failures, concurrency, and
 * the actual stock-ledger effect of an applied count.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Physical stock count (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let sc: typeof import("@/lib/stock-count");

  let restaurantId: string;
  let otherRestaurantId: string;
  let branchId: string;
  let branchBId: string;
  let otherRestaurantBranchId: string;
  let userId: string;
  let itemId: string; // cost 10_000 paisa/kg
  let cheapItemId: string; // cost 100 paisa/kg — for percent-only-large tests

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    sc = await import("@/lib/stock-count");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-stock-count-${suffix}`, name: "TEST Stock Count Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-stock-count-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch B", isMain: false })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Other Main", isMain: true })
      .returning({ id: schema.branches.id });
    otherRestaurantBranchId = otherBranch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Stock Count User", phone: `974${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [item] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Count Item", unit: "kg", costPerUnitInPaisa: 10_000 })
      .returning({ id: schema.inventoryItems.id });
    itemId = item.id;

    const [cheapItem] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Cheap Count Item", unit: "kg", costPerUnitInPaisa: 100 })
      .returning({ id: schema.inventoryItems.id });
    cheapItemId = cheapItem.id;
  });

  afterAll(async () => {
    // stock_count_items.inventoryItemId and purchase_items.inventoryItemId
    // are both ON DELETE RESTRICT — same pattern as every other inventory
    // integration-test cleanup in this project (see supplier-dues.test.ts):
    // delete stock_counts (cascades stock_count_items), then the inventory
    // items (cascades their branch-level rows), before the restaurant.
    await db.delete(schema.stockCounts).where(eq(schema.stockCounts.restaurantId, restaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  /**
   * Creates a brand-new inventory item so tests that need a precise,
   * deterministic system-quantity snapshot never share running stock
   * totals with any other test — branch_inventory_levels accumulates via
   * `+=`, so reusing one item across tests would make each test's
   * "system quantity" depend on execution order/what earlier tests left
   * behind (the exact bug class product-profitability.test.ts's own
   * history warns about — see this project's commit history for that
   * fix). A fresh item per test sidesteps it entirely rather than relying
   * on ordering.
   */
  async function createItem(costPerUnitInPaisa: number) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: `TEST Count Item ${suffix}`, unit: "kg", costPerUnitInPaisa })
      .returning({ id: schema.inventoryItems.id });
    return item.id;
  }

  /** Gives an item a known branch-level system stock via a real stock movement, so addStockCountItem's snapshot is deterministic. Only safe on an item that has had no other movements at this branch — see createItem's own comment. */
  async function setSystemStock(targetItemId: string, targetBranchId: string, quantityMilliunits: number) {
    const inventoryLib = await import("@/lib/inventory");
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId,
        branchId: targetBranchId,
        inventoryItemId: targetItemId,
        type: "adjustment",
        quantityDeltaMilliunits: quantityMilliunits,
        note: "TEST seed system stock",
        recordedByUserId: userId,
      }),
    );
  }

  it("variance/threshold helpers: computeVarianceMilliunits, computeVarianceValueInPaisa, isLargeVariance", () => {
    expect(sc.computeVarianceMilliunits(10_000, 9_500)).toBe(-500);
    expect(sc.computeVarianceMilliunits(10_000, 10_000)).toBe(0);
    expect(sc.computeVarianceValueInPaisa(-500, 10_000)).toBe(-5_000); // -0.5kg * 10_000/kg

    // Small variance (value + percent both under threshold): not large.
    expect(
      sc.isLargeVariance({ varianceMilliunits: -100, systemQuantityMilliunits: 10_000, unitCostInPaisaSnapshot: 100 }),
    ).toBe(false);
    // Large by VALUE alone (small % of a huge system qty, but big rupees).
    expect(
      sc.isLargeVariance({
        varianceMilliunits: -6_000,
        systemQuantityMilliunits: 1_000_000,
        unitCostInPaisaSnapshot: 10_000,
      }),
    ).toBe(true); // 6kg * 10_000/kg = 60_000 paisa > 50_000 threshold
    // Large by PERCENT alone (small rupee value, but >10% of system qty).
    expect(
      sc.isLargeVariance({ varianceMilliunits: -200, systemQuantityMilliunits: 1_000, unitCostInPaisaSnapshot: 100 }),
    ).toBe(true); // 20% of system qty, only 20 paisa value
    expect(sc.isLargeVariance({ varianceMilliunits: 0, systemQuantityMilliunits: 1_000, unitCostInPaisaSnapshot: 100 })).toBe(
      false,
    );
  });

  it("happy path: small variance auto-applies on submit and writes the correct stock movement", async () => {
    const freshItemId = await createItem(10_000);
    await setSystemStock(freshItemId, branchId, 10_000); // 10kg

    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId, notes: "TEST routine count" });
    expect(count.status).toBe("open");

    const item = await db.transaction((tx) =>
      sc.addStockCountItem(tx, {
        restaurantId,
        stockCountId: count.id,
        inventoryItemId: freshItemId,
        physicalQuantityMilliunits: 9_900, // 0.1kg short — well under both thresholds
      }),
    );
    expect(item.systemQuantityMilliunits).toBe(10_000);
    expect(item.unitCostInPaisaSnapshot).toBe(10_000);

    const result = await db.transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: count.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" }));
    expect(result.stockCount.status).toBe("applied");
    expect(result.stockCount.hasLargeVariance).toBe(false);
    expect(result.appliedMovementCount).toBe(1);

    const [movement] = await db
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.referenceId, count.id));
    expect(movement.type).toBe("adjustment");
    expect(movement.quantityDeltaMilliunits).toBe(-100);

    const [branchLevel] = await db
      .select()
      .from(schema.branchInventoryLevels)
      .where(eq(schema.branchInventoryLevels.inventoryItemId, freshItemId));
    expect(branchLevel.currentStockMilliunits).toBe(9_900);
  });

  it("happy path: large variance goes to pending_approval, is left un-applied until approved, then approve() writes the movement", async () => {
    const freshItemId = await createItem(10_000);
    await setSystemStock(freshItemId, branchId, 20_000); // 20kg

    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await db.transaction((tx) =>
      sc.addStockCountItem(tx, {
        restaurantId,
        stockCountId: count.id,
        inventoryItemId: freshItemId,
        physicalQuantityMilliunits: 15_000, // 5kg short = 50_000 paisa, over the value threshold
      }),
    );

    const submitResult = await db.transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: count.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" }));
    expect(submitResult.stockCount.status).toBe("pending_approval");
    expect(submitResult.stockCount.hasLargeVariance).toBe(true);
    expect(submitResult.appliedMovementCount).toBe(0);

    const noMovementYet = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.referenceId, count.id));
    expect(noMovementYet).toHaveLength(0);

    const approveResult = await db.transaction((tx) => sc.approveStockCount(tx, { restaurantId, stockCountId: count.id, approvedByUserId: userId, timezone: "Asia/Kathmandu" }));
    expect(approveResult.stockCount.status).toBe("applied");
    expect(approveResult.stockCount.approvedByUserId).toBe(userId);
    expect(approveResult.appliedMovementCount).toBe(1);

    const [movement] = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.referenceId, count.id));
    expect(movement.quantityDeltaMilliunits).toBe(-5_000);
  });

  it("reject: a large-variance count moving to pending_approval and then rejected writes NO stock movement", async () => {
    const freshItemId = await createItem(10_000);
    await setSystemStock(freshItemId, branchId, 30_000);

    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await db.transaction((tx) =>
      sc.addStockCountItem(tx, { restaurantId, stockCountId: count.id, inventoryItemId: freshItemId, physicalQuantityMilliunits: 20_000 }),
    );
    await db.transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: count.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" }));

    const rejected = await db.transaction((tx) =>
      sc.rejectStockCount(tx, { restaurantId, stockCountId: count.id, rejectedByUserId: userId, reason: "TEST recount needed" }),
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("TEST recount needed");

    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.referenceId, count.id));
    expect(movements).toHaveLength(0);

    const [branchLevel] = await db
      .select()
      .from(schema.branchInventoryLevels)
      .where(eq(schema.branchInventoryLevels.inventoryItemId, freshItemId));
    expect(branchLevel.currentStockMilliunits).toBe(30_000); // unchanged
  });

  it("wrong-restaurant isolation: neither getStockCountDetail nor addStockCountItem/submit work against a count from another restaurant", async () => {
    const otherCount = await sc.createStockCount({
      restaurantId: otherRestaurantId,
      branchId: otherRestaurantBranchId,
      countedByUserId: userId,
    });

    await expect(sc.getStockCountDetail(restaurantId, otherCount.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      db.transaction((tx) => sc.addStockCountItem(tx, { restaurantId, stockCountId: otherCount.id, inventoryItemId: itemId })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      db.transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: otherCount.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" })),
    ).rejects.toMatchObject({ status: 404 });

    const ownReport = await sc.getStockCountDetail(otherRestaurantId, otherCount.id);
    expect(ownReport.stockCount.id).toBe(otherCount.id);
  });

  it("wrong-branch: listStockCounts scoped to one branch never returns a count created for a different branch of the same restaurant", async () => {
    const countA = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    const countB = await sc.createStockCount({ restaurantId, branchId: branchBId, countedByUserId: userId });

    const branchAList = await sc.listStockCounts(restaurantId, { branchId });
    expect(branchAList.some((c) => c.id === countB.id)).toBe(false);
    expect(branchAList.some((c) => c.id === countA.id)).toBe(true);

    const branchBList = await sc.listStockCounts(restaurantId, { branchId: branchBId });
    expect(branchBList.some((c) => c.id === countA.id)).toBe(false);
    expect(branchBList.some((c) => c.id === countB.id)).toBe(true);
  });

  it("validation failure: submitting an empty count, or a count with an uncounted item, is rejected", async () => {
    const emptyCount = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await expect(
      db.transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: emptyCount.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" })),
    ).rejects.toMatchObject({ status: 400 });

    const partialCount = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await db.transaction((tx) =>
      sc.addStockCountItem(tx, { restaurantId, stockCountId: partialCount.id, inventoryItemId: itemId }), // no physicalQuantityMilliunits
    );
    await expect(
      db.transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: partialCount.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validation failure: adding the same item to a count twice is rejected (duplicate request)", async () => {
    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await db.transaction((tx) => sc.addStockCountItem(tx, { restaurantId, stockCountId: count.id, inventoryItemId: cheapItemId }));
    await expect(
      db.transaction((tx) => sc.addStockCountItem(tx, { restaurantId, stockCountId: count.id, inventoryItemId: cheapItemId })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("an already-submitted (applied) count rejects further edits and a duplicate submit", async () => {
    const freshItemId = await createItem(100);
    await setSystemStock(freshItemId, branchId, 5_000);
    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await db.transaction((tx) =>
      sc.addStockCountItem(tx, { restaurantId, stockCountId: count.id, inventoryItemId: freshItemId, physicalQuantityMilliunits: 5_000 }),
    );
    const first = await db.transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: count.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" }));
    expect(first.stockCount.status).toBe("applied");

    await expect(
      db.transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: count.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db.transaction((tx) => sc.addStockCountItem(tx, { restaurantId, stockCountId: count.id, inventoryItemId: itemId })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("approve/reject reject a count that isn't pending_approval (e.g. still open, or already applied)", async () => {
    const openCount = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await expect(
      db.transaction((tx) => sc.approveStockCount(tx, { restaurantId, stockCountId: openCount.id, approvedByUserId: userId, timezone: "Asia/Kathmandu" })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db.transaction((tx) => sc.rejectStockCount(tx, { restaurantId, stockCountId: openCount.id, rejectedByUserId: userId, reason: "TEST" })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rollback on failure: submitting with an unknown inventory item never leaves a half-applied count (item add itself is rejected, count stays open)", async () => {
    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await expect(
      db.transaction((tx) =>
        sc.addStockCountItem(tx, {
          restaurantId,
          stockCountId: count.id,
          inventoryItemId: "00000000-0000-0000-0000-000000000000",
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });

    const detail = await sc.getStockCountDetail(restaurantId, count.id);
    expect(detail.stockCount.status).toBe("open");
    expect(detail.items).toHaveLength(0);
  });

  it("two concurrent submitStockCount calls on the same count: exactly one succeeds, the other gets a clean conflict", async () => {
    const freshItemId = await createItem(100);
    await setSystemStock(freshItemId, branchId, 8_000);
    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await db.transaction((tx) =>
      sc.addStockCountItem(tx, { restaurantId, stockCountId: count.id, inventoryItemId: freshItemId, physicalQuantityMilliunits: 7_900 }),
    );

    const attempt = () =>
      db
        .transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: count.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" }))
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);

    // Exactly one stock movement was written — a race would double-apply
    // the variance if the row lock/CAS pair didn't fully serialize this.
    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.referenceId, count.id));
    expect(movements).toHaveLength(1);
  });

  it("edge case: a zero physical-count (found nothing) is a valid, non-negative quantity and produces a full-shrinkage variance", async () => {
    const freshItemId = await createItem(100);
    await setSystemStock(freshItemId, branchId, 3_000);
    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    const item = await db.transaction((tx) =>
      sc.addStockCountItem(tx, { restaurantId, stockCountId: count.id, inventoryItemId: freshItemId, physicalQuantityMilliunits: 0 }),
    );
    expect(item.physicalQuantityMilliunits).toBe(0);

    const detail = await sc.getStockCountDetail(restaurantId, count.id);
    const line = detail.items.find((i) => i.id === item.id)!;
    expect(line.varianceMilliunits).toBe(-3_000);
  });

  it("edge case: zero variance (physical matches system exactly) writes no stock movement at all", async () => {
    const freshItemId = await createItem(100);
    await setSystemStock(freshItemId, branchId, 4_000);
    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    await db.transaction((tx) =>
      sc.addStockCountItem(tx, { restaurantId, stockCountId: count.id, inventoryItemId: freshItemId, physicalQuantityMilliunits: 4_000 }),
    );
    const result = await db.transaction((tx) => sc.submitStockCount(tx, { restaurantId, stockCountId: count.id, submittedByUserId: userId, timezone: "Asia/Kathmandu" }));
    expect(result.stockCount.status).toBe("applied");
    expect(result.appliedMovementCount).toBe(0);

    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.referenceId, count.id));
    expect(movements).toHaveLength(0);
  });

  it("setStockCountItemPhysicalQuantity lets a counter correct a value while still open, and getStockCountDetail reflects the correction", async () => {
    const count = await sc.createStockCount({ restaurantId, branchId, countedByUserId: userId });
    const item = await db.transaction((tx) =>
      sc.addStockCountItem(tx, { restaurantId, stockCountId: count.id, inventoryItemId: itemId, physicalQuantityMilliunits: 1_000 }),
    );
    await db.transaction((tx) =>
      sc.setStockCountItemPhysicalQuantity(tx, {
        restaurantId,
        stockCountId: count.id,
        stockCountItemId: item.id,
        physicalQuantityMilliunits: 2_000,
        note: "TEST recounted, misread the scale the first time",
      }),
    );

    const detail = await sc.getStockCountDetail(restaurantId, count.id);
    const line = detail.items.find((i) => i.id === item.id)!;
    expect(line.physicalQuantityMilliunits).toBe(2_000);
    expect(line.note).toBe("TEST recounted, misread the scale the first time");
  });
});
