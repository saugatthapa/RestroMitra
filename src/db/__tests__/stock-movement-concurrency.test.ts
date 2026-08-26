/**
 * QA hardening (P2 backlog): regression coverage for the concurrency
 * property FINAL_HARDENING_REPORT.md explicitly flagged as untested — "no
 * dedicated test for two concurrent orders deducting the same ingredient
 * (the underlying mechanism is an atomic SQL increment, so this is a
 * coverage gap, not a suspected bug)".
 *
 * recordStockMovement() (src/lib/inventory.ts) is the single choke point
 * every ingredient deduction (and purchase, waste, transfer, adjustment)
 * goes through. Its own doc comment explains why it's safe under
 * concurrency: the stock-quantity update is a SQL `+= delta` inside the
 * UPDATE's SET clause, not a JS read-modify-write — so two concurrent
 * calls against the same item can't race and silently drop one delta,
 * unlike applyPurchaseCosting's cost-averaging (covered separately by
 * inventory-cost-race.test.ts, which needed an actual row-lock fix).
 *
 * This test proves that property holds under genuine Promise.all
 * concurrency, simulating exactly the scenario the report called out: two
 * orders for dishes sharing one ingredient, both deducting stock for that
 * ingredient at the same moment.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("recordStockMovement concurrency (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let inventoryLib: typeof import("@/lib/inventory");

  let restaurantId: string;
  let branchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    inventoryLib = await import("@/lib/inventory");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-stock-race-${suffix}`, name: "TEST Stock Movement Race Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main Branch", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;
  });

  afterAll(async () => {
    await db.delete(schema.stockMovements).where(eq(schema.stockMovements.restaurantId, restaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function createItem(initialStockMilliunits: number) {
    const [item] = await db
      .insert(schema.inventoryItems)
      .values({
        restaurantId,
        name: "TEST Shared Ingredient",
        unit: "kg",
        currentStockMilliunits: initialStockMilliunits,
        costPerUnitInPaisa: 10_000,
      })
      .returning({ id: schema.inventoryItems.id });
    return item.id;
  }

  it("two concurrent order deductions against the SAME ingredient both apply — no lost update", async () => {
    // 10 units on hand — plenty of headroom, so this isn't also exercising
    // the (separately allowed, per PHASE_7_NOTES.md) negative-stock path.
    const itemId = await createItem(10_000);

    const deduct = (orderId: string, quantityMilliunits: number) =>
      db.transaction((tx) =>
        inventoryLib.recordStockMovement(tx, {
          restaurantId,
          branchId,
          inventoryItemId: itemId,
          type: "sale_deduction",
          quantityDeltaMilliunits: -quantityMilliunits,
          referenceType: "order",
          referenceId: orderId,
        }),
      );

    // Two different orders, placed at the same moment, both needing this
    // same ingredient — order A's dish uses 500g, order B's uses 300g.
    const orderIdA = randomUUID();
    const orderIdB = randomUUID();
    const [resultA, resultB] = await Promise.all([
      deduct(orderIdA, 500),
      deduct(orderIdB, 300),
    ]);

    // Both calls must have actually gone through — neither silently no-oped.
    expect(resultA.movement.id).not.toBe(resultB.movement.id);

    const [finalItem] = await db
      .select()
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, itemId));
    // A lost update would leave this at 9500 or 9700 (whichever write
    // landed last silently clobbering the other) instead of reflecting
    // BOTH deductions.
    expect(finalItem.currentStockMilliunits).toBe(10_000 - 500 - 300);

    const [branchLevel] = await db
      .select()
      .from(schema.branchInventoryLevels)
      .where(eq(schema.branchInventoryLevels.inventoryItemId, itemId));
    // The per-branch cached level (used for branch-filtered inventory
    // views) must reflect both deductions too, not just the item's
    // restaurant-wide total.
    expect(branchLevel.currentStockMilliunits).toBe(-500 - 300);

    const movements = await db
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.inventoryItemId, itemId));
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => m.referenceId).sort()).toEqual([orderIdA, orderIdB].sort());
  });

  it("three-way concurrent deduction against the same ingredient also loses nothing", async () => {
    // A slightly wider fan-out than the two-way case above, closer to a
    // genuinely busy service period where several tickets fire together.
    const itemId = await createItem(10_000);

    const deduct = (orderId: string, quantityMilliunits: number) =>
      db.transaction((tx) =>
        inventoryLib.recordStockMovement(tx, {
          restaurantId,
          branchId,
          inventoryItemId: itemId,
          type: "sale_deduction",
          quantityDeltaMilliunits: -quantityMilliunits,
          referenceType: "order",
          referenceId: orderId,
        }),
      );

    await Promise.all([
      deduct(randomUUID(), 200),
      deduct(randomUUID(), 150),
      deduct(randomUUID(), 100),
    ]);

    const [finalItem] = await db
      .select()
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, itemId));
    expect(finalItem.currentStockMilliunits).toBe(10_000 - 200 - 150 - 100);

    const movements = await db
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.inventoryItemId, itemId));
    expect(movements).toHaveLength(3);
  });
});
