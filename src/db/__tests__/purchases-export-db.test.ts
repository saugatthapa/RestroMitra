/**
 * Commercial completion pass (Data Export gap — purchases) integration
 * tests for listPurchasesForExport() in src/lib/inventory.ts — the
 * function backing GET /api/restaurants/[slug]/purchases/export.
 * RBAC/permission gating (MANAGE_INVENTORY) lives in the route itself and
 * resolveRestaurantContext's own tests already cover that layer (see
 * ledger-list.test.ts's own comment on the same split) — this file
 * exercises the query's tenant isolation, branch scoping, and the linked
 * ledger due-status join directly.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("listPurchasesForExport (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let inventory: typeof import("@/lib/inventory");
  let ledger: typeof import("@/lib/ledger");

  let ownerId: string;
  let restaurantId: string;
  let otherRestaurantId: string;
  let branchAId: string;
  let branchBId: string;
  let otherBranchId: string;
  let itemId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    inventory = await import("@/lib/inventory");
    ledger = await import("@/lib/ledger");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Purchases Export Owner", phone: `9720${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-purchases-export-${suffix}`, name: "TEST Purchases Export Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-purchases-export-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch A", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch B" })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Other Restaurant Main", isMain: true })
      .returning({ id: schema.branches.id });
    otherBranchId = otherBranch.id;

    const [item] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Flour", unit: "kg" })
      .returning({ id: schema.inventoryItems.id });
    itemId = item.id;
  });

  afterAll(async () => {
    await db.delete(schema.purchases).where(eq(schema.purchases.restaurantId, restaurantId));
    await db.delete(schema.purchases).where(eq(schema.purchases.restaurantId, otherRestaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  async function insertPurchase(params: {
    targetRestaurantId: string;
    branchId: string;
    invoiceNumber: string;
    isCredit?: boolean;
    totalInPaisa?: number;
  }) {
    return db.transaction(async (tx) => {
      const total = params.totalInPaisa ?? 5_000;
      const [purchase] = await tx
        .insert(schema.purchases)
        .values({
          restaurantId: params.targetRestaurantId,
          branchId: params.branchId,
          invoiceNumber: params.invoiceNumber,
          totalInPaisa: total,
          isCredit: params.isCredit ?? false,
          recordedByUserId: ownerId,
        })
        .returning();

      await tx.insert(schema.purchaseItems).values({
        purchaseId: purchase.id,
        inventoryItemId: itemId,
        quantityMilliunits: 1_000,
        unitCostInPaisa: total,
        lineTotalInPaisa: total,
      });

      await ledger.recordPurchaseLedgerEntry(tx, {
        restaurantId: params.targetRestaurantId,
        purchaseId: purchase.id,
        totalInPaisa: total,
        invoiceNumber: params.invoiceNumber,
        timezone: "UTC",
        markAsDue: params.isCredit ?? false,
        recordedByUserId: ownerId,
      });

      return purchase;
    });
  }

  it("happy path: lists purchases for the restaurant with items and ledger due status", async () => {
    const purchase = await insertPurchase({
      targetRestaurantId: restaurantId,
      branchId: branchAId,
      invoiceNumber: "INV-001",
      isCredit: true,
      totalInPaisa: 10_000,
    });

    const rows = await inventory.listPurchasesForExport(restaurantId, null, 100);
    const row = rows.find((r) => r.id === purchase.id);
    expect(row).toBeDefined();
    expect(row!.items).toHaveLength(1);
    expect(row!.items[0].inventoryItem.name).toBe("TEST Flour");
    expect(row!.ledgerEntry?.dueStatus).toBe("outstanding");
    expect(row!.ledgerEntry?.amountInPaisa).toBe(10_000);
  });

  it("wrong-restaurant isolation: never returns another restaurant's purchases", async () => {
    const other = await insertPurchase({
      targetRestaurantId: otherRestaurantId,
      branchId: otherBranchId,
      invoiceNumber: "INV-OTHER",
    });

    const rows = await inventory.listPurchasesForExport(restaurantId, null, 100);
    expect(rows.some((r) => r.id === other.id)).toBe(false);
  });

  it("scopes to one branch when branchId is given (not null)", async () => {
    const inBranchB = await insertPurchase({
      targetRestaurantId: restaurantId,
      branchId: branchBId,
      invoiceNumber: "INV-BRANCH-B",
    });
    const inBranchA = await insertPurchase({
      targetRestaurantId: restaurantId,
      branchId: branchAId,
      invoiceNumber: "INV-BRANCH-A",
    });

    const rows = await inventory.listPurchasesForExport(restaurantId, branchBId, 100);
    expect(rows.some((r) => r.id === inBranchB.id)).toBe(true);
    expect(rows.some((r) => r.id === inBranchA.id)).toBe(false);
  });

  it("respects a custom limit", async () => {
    const rows = await inventory.listPurchasesForExport(restaurantId, null, 1);
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});
