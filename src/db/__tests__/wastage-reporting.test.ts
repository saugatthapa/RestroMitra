/**
 * P2 integration test for getWastageSummary/getReportSummary's wastage
 * fields (src/lib/reports.ts) — proves the cost math against hand-computed
 * values, that movements are grouped by wasteReason correctly, that a
 * non-waste movement (e.g. a plain "adjustment") is excluded, and that a
 * branch with no waste reports zero rather than erroring. Closes the gap
 * the P2 audit flagged: wastage was recordable but had no report reading
 * it back.
 *
 * Kept as its own file/fixture (not folded into cogs-reporting.test.ts)
 * deliberately, same rationale as that file's own header comment — a
 * shared fixture's exact hand-computed totals would be perturbed by
 * inserting unrelated stock movements into the same range.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Wastage reporting (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let reports: typeof import("@/lib/reports");

  let restaurantId: string;
  let branchId: string;

  const RANGE = { from: "2026-07-01", to: "2026-07-07" };
  const TZ = "UTC";

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    reports = await import("@/lib/reports");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-wastage-${suffix}`, name: "TEST Wastage Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [bun] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Waste Bun", unit: "piece", costPerUnitInPaisa: 2_000 }) // Rs 20/piece
      .returning({ id: schema.inventoryItems.id });
    const [cheese] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Waste Cheese", unit: "kg", costPerUnitInPaisa: 80_000 }) // Rs 800/kg
      .returning({ id: schema.inventoryItems.id });

    await db.insert(schema.stockMovements).values([
      // 3 whole buns spoiled: 3 * 2_000 = 6_000 paisa.
      {
        restaurantId,
        branchId,
        inventoryItemId: bun.id,
        type: "waste",
        wasteReason: "spoilage",
        quantityDeltaMilliunits: -3000,
        note: "TEST left out overnight",
        createdAt: new Date("2026-07-03T10:00:00Z"),
      },
      // 250g of cheese broken/dropped: 0.25 * 80_000 = 20_000 paisa.
      {
        restaurantId,
        branchId,
        inventoryItemId: cheese.id,
        type: "waste",
        wasteReason: "breakage",
        quantityDeltaMilliunits: -250,
        note: "TEST dropped block",
        createdAt: new Date("2026-07-04T10:00:00Z"),
      },
      // 100g more of cheese spoiled: 0.1 * 80_000 = 8_000 paisa — same
      // reason as the bun above, proving cross-item grouping by reason.
      {
        restaurantId,
        branchId,
        inventoryItemId: cheese.id,
        type: "waste",
        wasteReason: "spoilage",
        quantityDeltaMilliunits: -100,
        note: "TEST gone off",
        createdAt: new Date("2026-07-05T10:00:00Z"),
      },
      // A plain count-correction adjustment, NOT waste — must be excluded
      // from the wastage summary entirely, even though it's a negative
      // delta on the same item within the same range.
      {
        restaurantId,
        branchId,
        inventoryItemId: bun.id,
        type: "adjustment",
        wasteReason: null,
        quantityDeltaMilliunits: -1000,
        note: "TEST recount correction",
        createdAt: new Date("2026-07-05T12:00:00Z"),
      },
      // Spoilage OUTSIDE the range — must not be counted.
      {
        restaurantId,
        branchId,
        inventoryItemId: bun.id,
        type: "waste",
        wasteReason: "spoilage",
        quantityDeltaMilliunits: -5000,
        note: "TEST out of range",
        createdAt: new Date("2026-06-01T10:00:00Z"),
      },
    ]);
  });

  afterAll(async () => {
    // stockMovements/inventoryItems/branches all cascade off restaurants.
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("getWastageSummary sums cost by reason, excludes non-waste movements and out-of-range rows", async () => {
    const wastage = await reports.getWastageSummary(restaurantId, RANGE, TZ);
    expect(wastage.wastageCostInPaisa).toBe(34_000); // 6_000 + 20_000 + 8_000
    expect(wastage.movementCount).toBe(3);
    expect(wastage.byReason).toEqual(
      expect.arrayContaining([
        { reason: "spoilage", costInPaisa: 14_000, movementCount: 2 },
        { reason: "breakage", costInPaisa: 20_000, movementCount: 1 },
      ]),
    );
    expect(wastage.byReason).toHaveLength(2);
  });

  it("getReportSummary surfaces wastageCostInPaisa alongside cogsInPaisa/netProfitInPaisa", async () => {
    const summary = await reports.getReportSummary(restaurantId, RANGE, TZ);
    expect(summary.wastageCostInPaisa).toBe(34_000);
    expect(summary.wastageMovementCount).toBe(3);
    expect(summary.wastageByReason).toHaveLength(2);
    // No orders in this fixture — revenue/COGS/net-profit stay zero,
    // proving wastage is computed independently of the sales-side queries.
    expect(summary.sales.revenueInPaisa).toBe(0);
    expect(summary.cogsInPaisa).toBe(0);
  });

  it("a branch with no waste movements reports zero, not an error", async () => {
    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Empty Waste Branch", isMain: false })
      .returning({ id: schema.branches.id });
    const wastage = await reports.getWastageSummary(restaurantId, RANGE, TZ, otherBranch.id);
    expect(wastage).toEqual({ wastageCostInPaisa: 0, movementCount: 0, byReason: [] });
  });
});
