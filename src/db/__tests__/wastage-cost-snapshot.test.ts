/**
 * Commercial-launch Phase A.5 regression tests for the cost-snapshot
 * columns recordStockMovement now writes (src/lib/inventory.ts) —
 * stock_movements.unitCostInPaisaSnapshot/totalCostInPaisaSnapshot — and
 * getWastageSummary's (src/lib/reports.ts) preference for that frozen
 * value over inventoryItems' current live cost. Same correctness fix as
 * orderItems.recipeCostInPaisa (see product-profitability.test.ts): a
 * wastage report re-deriving an old movement's cost from TODAY's rate
 * would silently misstate history whenever a later purchase moved the
 * item's weighted-average cost.
 *
 * Also proves the new "damaged"/"burned" waste reasons (added to match
 * the commercial-launch spec's exact reason list) round-trip correctly.
 *
 * wastage-reporting.test.ts (unchanged, still passing) already covers the
 * live-fallback path for pre-existing rows with no snapshot — kept
 * separate here rather than folded together for the same "own fixture,
 * own exact totals" reasoning that file's header comment gives.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Wastage cost snapshot (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let reports: typeof import("@/lib/reports");
  let inventoryLib: typeof import("@/lib/inventory");

  let restaurantId: string;
  let branchId: string;
  let itemId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    reports = await import("@/lib/reports");
    inventoryLib = await import("@/lib/inventory");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-waste-snapshot-${suffix}`, name: "TEST Waste Snapshot Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [item] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Waste Snapshot Item", unit: "kg", costPerUnitInPaisa: 10_000 })
      .returning({ id: schema.inventoryItems.id });
    itemId = item.id;
  });

  afterAll(async () => {
    await db.delete(schema.recipeItems).where(eq(schema.recipeItems.restaurantId, restaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("recordStockMovement freezes unitCostInPaisaSnapshot/totalCostInPaisaSnapshot at the item's cost when the movement happens", async () => {
    const result = await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId,
        branchId,
        inventoryItemId: itemId,
        type: "waste",
        wasteReason: "damaged",
        quantityDeltaMilliunits: -500, // 0.5 kg
        note: "TEST dropped tray",
      }),
    );
    // 0.5 kg * 10_000 paisa/kg = 5_000.
    expect(result.movement.unitCostInPaisaSnapshot).toBe(10_000);
    expect(result.movement.totalCostInPaisaSnapshot).toBe(5_000);
    expect(result.movement.wasteReason).toBe("damaged");
  });

  it("the 'burned' waste reason is accepted too (matches the spec's exact reason list)", async () => {
    const result = await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId,
        branchId,
        inventoryItemId: itemId,
        type: "waste",
        wasteReason: "burned",
        quantityDeltaMilliunits: -100,
        note: "TEST burned in the kitchen",
      }),
    );
    expect(result.movement.wasteReason).toBe("burned");
  });

  it("getWastageSummary uses the FROZEN snapshot, not today's live cost — a later purchase changing the weighted-average cost does not retroactively change past wastage cost", async () => {
    const before = await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId,
        branchId,
        inventoryItemId: itemId,
        type: "waste",
        wasteReason: "spoilage",
        quantityDeltaMilliunits: -1000, // 1 kg
        note: "TEST spoiled",
      }),
    );
    expect(before.movement.totalCostInPaisaSnapshot).toBe(10_000); // 1kg * 10_000

    // The item's cost rises sharply — if getWastageSummary re-derived cost
    // live, this movement's reported cost would silently jump too.
    await db.update(schema.inventoryItems).set({ costPerUnitInPaisa: 90_000 }).where(eq(schema.inventoryItems.id, itemId));

    const businessDate = before.movement.createdAt;
    const range = { from: businessDate.toISOString().slice(0, 10), to: businessDate.toISOString().slice(0, 10) };
    const wastage = await reports.getWastageSummary(restaurantId, range, "UTC", branchId);
    const spoilageRow = wastage.byReason.find((r) => r.reason === "spoilage")!;
    expect(spoilageRow.costInPaisa).toBe(10_000); // frozen, not 1kg * 90_000 = 90_000
  });
});
