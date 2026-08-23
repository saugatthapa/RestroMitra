import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import {
  inventoryItems,
  stockMovements,
  orderItems,
  recipeItems,
  branches,
  branchInventoryLevels,
} from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import type { WasteReasonValue } from "@/lib/waste-reasons";

export class InventoryError extends HttpError {
  constructor(message: string) {
    super(message, 400);
  }
}

export type StockMovementType = "purchase" | "sale_deduction" | "adjustment" | "waste";
export type WasteReason = WasteReasonValue;

/**
 * The single choke point for changing an inventory item's stock. Inserts a
 * row into the stock_movements ledger AND atomically increments BOTH the
 * item's cached restaurant-wide currentStockMilliunits AND its per-branch
 * row in branch_inventory_levels, all in the same transaction (SQL
 * `+= delta` updates, not a read-then-write in JS, so concurrent movements
 * against the same item/branch can't race and drop one of them — same
 * pattern the restaurant-wide update already used before P2, now extended
 * to the branch-level table via an atomic upsert).
 *
 * `tx` should be the transaction handle from an enclosing
 * `db.transaction(async (tx) => ...)` block — every caller of this
 * function needs its ledger insert and stock update to commit or roll back
 * together with whatever triggered it (a purchase, an order transition, a
 * manual adjustment).
 *
 * `branchId` is required (P2 — see stock_movements.branchId's schema
 * comment) and is verified to belong to this restaurant here, defense in
 * depth same as the inventory-item ownership check below — every caller
 * should already have resolved it from a restaurant-scoped branch list,
 * but a wrong id must fail closed, not silently attribute stock to another
 * tenant's branch.
 */
export async function recordStockMovement(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    inventoryItemId: string;
    type: StockMovementType;
    quantityDeltaMilliunits: number;
    wasteReason?: WasteReason | null;
    referenceType?: string | null;
    referenceId?: string | null;
    note?: string | null;
    recordedByUserId?: string | null;
  },
) {
  if (params.quantityDeltaMilliunits === 0) {
    throw new InventoryError("A stock movement must have a non-zero quantity.");
  }
  if (params.type === "waste") {
    if (params.quantityDeltaMilliunits > 0) {
      throw new InventoryError("A waste movement must reduce stock, not add to it.");
    }
    if (!params.wasteReason) {
      throw new InventoryError("A waste movement requires a reason.");
    }
  } else if (params.wasteReason) {
    throw new InventoryError("wasteReason only applies to waste movements.");
  }

  const branchRows = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, params.branchId), eq(branches.restaurantId, params.restaurantId)))
    .limit(1);
  if (!branchRows[0]) {
    throw new InventoryError("Branch not found for this restaurant.");
  }

  const [movement] = await tx
    .insert(stockMovements)
    .values({
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      inventoryItemId: params.inventoryItemId,
      type: params.type,
      quantityDeltaMilliunits: params.quantityDeltaMilliunits,
      wasteReason: params.wasteReason ?? null,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      note: params.note ?? null,
      recordedByUserId: params.recordedByUserId ?? null,
    })
    .returning();

  const [updatedItem] = await tx
    .update(inventoryItems)
    .set({
      currentStockMilliunits: sql`${inventoryItems.currentStockMilliunits} + ${params.quantityDeltaMilliunits}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inventoryItems.id, params.inventoryItemId),
        eq(inventoryItems.restaurantId, params.restaurantId),
      ),
    )
    .returning();

  if (!updatedItem) {
    // The item didn't belong to this restaurant — defense in depth even
    // though every route calling this should have already verified
    // ownership. Throwing here rolls back the whole transaction, including
    // the ledger insert above, so nothing is left half-applied.
    throw new InventoryError("Inventory item not found for this restaurant.");
  }

  const [branchLevel] = await tx
    .insert(branchInventoryLevels)
    .values({
      branchId: params.branchId,
      inventoryItemId: params.inventoryItemId,
      currentStockMilliunits: params.quantityDeltaMilliunits,
    })
    .onConflictDoUpdate({
      target: [branchInventoryLevels.branchId, branchInventoryLevels.inventoryItemId],
      set: {
        currentStockMilliunits: sql`${branchInventoryLevels.currentStockMilliunits} + ${params.quantityDeltaMilliunits}`,
        updatedAt: new Date(),
      },
    })
    .returning();

  return { movement, item: updatedItem, branchLevel };
}

/**
 * Records a purchase's effect on ONE inventory item: recomputes the
 * item's weighted-average cost-per-unit, then records the stock-in as a
 * "purchase" movement. Weighted average, not "last cost" — a single
 * unusually expensive or cheap restock shouldn't instantly become the
 * item's entire cost basis for margin calculations.
 *
 * Existing stock is clamped to >= 0 for the cost-basis calculation only
 * (never for the actual stock update) — averaging a cost against negative
 * "phantom" stock doesn't mean anything, since stock is allowed to go
 * negative in this phase (see PHASE_7_NOTES.md) but negative stock was
 * never actually paid for at any cost.
 *
 * P0-5 fix: the new cost is computed here in JS from the row this SELECT
 * reads (unlike recordStockMovement's stock-quantity update, which does its
 * `+= delta` entirely inside the SQL SET clause and so is safe on its own),
 * which makes this a genuine read-modify-write. Under Postgres's default
 * READ COMMITTED isolation a bare transaction does NOT protect that: two
 * concurrent purchases of the same item can both SELECT the same
 * pre-purchase cost/stock, each compute its own "correct" weighted average
 * from that stale snapshot, and whichever UPDATE commits second silently
 * overwrites the first — a lost update that under-costs the item forever
 * (the first purchase's price contribution vanishes from the average with
 * no trace). `.for("update")` locks this row for the rest of the
 * transaction so a second concurrent purchase's SELECT blocks until the
 * first commits, then reads the already-updated cost/stock instead of a
 * stale snapshot — same pattern as the order-locking call sites (e.g.
 * src/lib/tables.ts, the payments/adjustments/refunds routes).
 */
export async function applyPurchaseCosting(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    inventoryItemId: string;
    purchasedQuantityMilliunits: number;
    unitCostInPaisa: number;
    purchaseId: string;
    recordedByUserId?: string | null;
  },
) {
  const rows = await tx
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.id, params.inventoryItemId),
        eq(inventoryItems.restaurantId, params.restaurantId),
      ),
    )
    .for("update")
    .limit(1);
  const item = rows[0];
  if (!item) {
    throw new InventoryError("Inventory item not found for this restaurant.");
  }

  const oldStockForCosting = Math.max(item.currentStockMilliunits, 0);
  const totalMilliunitsAfter = oldStockForCosting + params.purchasedQuantityMilliunits;

  const newCostPerUnitInPaisa =
    totalMilliunitsAfter <= 0
      ? params.unitCostInPaisa
      : Math.round(
          (oldStockForCosting * item.costPerUnitInPaisa +
            params.purchasedQuantityMilliunits * params.unitCostInPaisa) /
            totalMilliunitsAfter,
        );

  await tx
    .update(inventoryItems)
    .set({ costPerUnitInPaisa: newCostPerUnitInPaisa, updatedAt: new Date() })
    .where(
      and(
        eq(inventoryItems.id, params.inventoryItemId),
        eq(inventoryItems.restaurantId, params.restaurantId),
      ),
    );

  return recordStockMovement(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    inventoryItemId: params.inventoryItemId,
    type: "purchase",
    quantityDeltaMilliunits: params.purchasedQuantityMilliunits,
    referenceType: "purchase",
    referenceId: params.purchaseId,
    recordedByUserId: params.recordedByUserId ?? null,
  });
}

/**
 * Deducts recipe ingredient stock for every item on an order, called
 * exactly once — when an order transitions confirmed -> preparing (see
 * the order status route). Relies on the order status state machine's
 * single-direction guarantee for idempotency: canTransition() never allows
 * preparing -> confirmed, so this specific transition can only ever fire
 * once per order — no separate "already deducted" flag needed.
 *
 * Order items with no menuItemId (the menu item was deleted since the
 * order was placed) or no recipe defined are silently skipped — recipes
 * are opt-in per menu item, not a hard requirement to take an order.
 */
export async function deductRecipeStockForOrder(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    orderId: string;
    recordedByUserId?: string | null;
  },
) {
  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, params.orderId));

  for (const item of items) {
    if (!item.menuItemId) continue;

    const recipe = await tx
      .select()
      .from(recipeItems)
      .where(eq(recipeItems.menuItemId, item.menuItemId));

    for (const line of recipe) {
      const deductionMilliunits = line.quantityPerServingMilliunits * item.quantity;
      if (deductionMilliunits === 0) continue;

      await recordStockMovement(tx, {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        inventoryItemId: line.inventoryItemId,
        type: "sale_deduction",
        quantityDeltaMilliunits: -deductionMilliunits,
        referenceType: "order",
        referenceId: params.orderId,
        note: `${item.quantity}x ${item.menuItemNameSnapshot}`,
        recordedByUserId: params.recordedByUserId ?? null,
      });
    }
  }
}

export function isLowStock(item: {
  currentStockMilliunits: number;
  reorderLevelMilliunits: number | null;
}): boolean {
  return (
    item.reorderLevelMilliunits !== null &&
    item.currentStockMilliunits <= item.reorderLevelMilliunits
  );
}
