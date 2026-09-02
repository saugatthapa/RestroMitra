import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import {
  inventoryItems,
  stockMovements,
  orderItems,
  orderItemAddons,
  recipeItems,
  addonRecipeItems,
  menuVariants,
  branches,
  branchInventoryLevels,
  ledgerEntries,
  purchases,
  restaurants,
} from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { formatQuantity } from "@/lib/quantity";
import type { WasteReasonValue } from "@/lib/waste-reasons";

export class InventoryError extends HttpError {
  constructor(message: string) {
    super(message, 400);
  }
}

export type StockMovementType =
  | "purchase"
  | "sale_deduction"
  | "adjustment"
  | "waste"
  | "transfer_out"
  | "transfer_in";
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

  // Joins restaurants in to pick up allowNegativeStock in the same
  // round-trip this branch-ownership check already made — no extra query.
  const branchRows = await tx
    .select({ id: branches.id, allowNegativeStock: restaurants.allowNegativeStock })
    .from(branches)
    .innerJoin(restaurants, eq(restaurants.id, branches.restaurantId))
    .where(and(eq(branches.id, params.branchId), eq(branches.restaurantId, params.restaurantId)))
    .limit(1);
  if (!branchRows[0]) {
    throw new InventoryError("Branch not found for this restaurant.");
  }
  const allowNegativeStock = branchRows[0].allowNegativeStock;

  // Read/update the item FIRST (before inserting the movement row) so its
  // resulting costPerUnitInPaisa — for a "purchase" movement this is
  // already the NEW post-purchase weighted average, since applyPurchaseCosting
  // updates it moments before calling this function; for every other
  // movement type it's simply the current, unchanged cost — is available
  // to freeze onto the movement row below. See stock_movements'
  // unitCostInPaisaSnapshot/totalCostInPaisaSnapshot column comments in
  // schema.ts for why this must be captured now, not re-derived later.
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

  const unitCostInPaisaSnapshot = updatedItem.costPerUnitInPaisa;
  const totalCostInPaisaSnapshot = Math.round(
    (Math.abs(params.quantityDeltaMilliunits) * unitCostInPaisaSnapshot) / 1000,
  );

  const [movement] = await tx
    .insert(stockMovements)
    .values({
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      inventoryItemId: params.inventoryItemId,
      type: params.type,
      quantityDeltaMilliunits: params.quantityDeltaMilliunits,
      wasteReason: params.wasteReason ?? null,
      unitCostInPaisaSnapshot,
      totalCostInPaisaSnapshot,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      note: params.note ?? null,
      recordedByUserId: params.recordedByUserId ?? null,
    })
    .returning();

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

  // P2 gap audit — hard stock enforcement (restaurants.allowNegativeStock,
  // see its own schema comment). Checked AFTER the atomic `+= delta`
  // writes above (both are `SET x = x + delta` SQL, not read-then-write in
  // JS, so the returned branchLevel is the true post-write value even
  // under concurrent movements against the same branch/item — same
  // reasoning as this function's own top-of-file comment) rather than
  // pre-checking, so a violation is caught with a single extra comparison
  // and no extra lock; throwing here rolls back this entire transaction
  // (the ledger insert and both cache updates included), so nothing is
  // left half-applied — same "throw to abort" idiom this codebase already
  // uses for every other CAS-style rejection (see stock-count.ts/
  // stock-transfer.ts).
  //
  // Only a NEGATIVE delta that leaves the branch negative is rejected — a
  // positive delta (purchase, transfer receipt, a stock-count overage) is
  // never blocked, even if the branch is still negative afterward from
  // stock that went negative before this toggle was turned on: this stops
  // NEW negative stock, it doesn't retroactively fix old negative stock.
  // Checked against the per-BRANCH cached level, not the restaurant-wide
  // total on `inventoryItems` — every caller of this function already
  // scopes the deduction to one physical branch (an order's branch, a
  // count's branch, a transfer's fromBranchId), and that branch's own
  // shelf is what "would take stock negative" means operationally; a
  // multi-branch restaurant's restaurant-wide total can stay negative from
  // another branch's pre-toggle history without blocking THIS branch's
  // otherwise-fine deduction.
  if (
    !allowNegativeStock &&
    params.quantityDeltaMilliunits < 0 &&
    branchLevel.currentStockMilliunits < 0
  ) {
    throw new InventoryError(
      `Not enough stock: this would leave "${updatedItem.name}" at ${formatQuantity(
        branchLevel.currentStockMilliunits,
        updatedItem.unit,
      )} at this branch, which is below zero. This restaurant has "Allow negative stock" turned off in Inventory settings — reduce the quantity, restock first, or turn the setting back on if this deduction should go through anyway.`,
    );
  }

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
 * An order item's total cost/deduction here has up to two independent
 * sources, both gap-audit P1 fixes (recipe costing) on top of the
 * original base-recipe-only behavior:
 *
 *  1. The BASE recipe (recipeItems, keyed by menuItemId), scaled by the
 *     selected variant's recipeQuantityMultiplierBasisPoints (10000 = 1x,
 *     unset/no-variant defaults to 10000 too — see menuVariants' own
 *     schema comment for why a multiplier rather than per-variant recipe
 *     overrides). Skipped entirely (not scaled to zero) when the item has
 *     no menuItemId (deleted since the order was placed) or no recipe was
 *     ever defined — recipes stay opt-in, same as before this fix.
 *  2. Each selected ADD-ON's own recipe (addonRecipeItems, keyed by
 *     addonId) — consumed once per unit of the item sold, same
 *     per-unit-scaling convention computeOrderPricing already uses for
 *     addon PRICE (addonUnitTotal * quantity), now extended to addon
 *     COST. Independent of the item's variant multiplier: an add-on's
 *     ingredient list is its own bill of materials, not a fraction of the
 *     base item's. An add-on with no addonRecipeItems rows contributes 0
 *     and does NOT by itself mark the line as cost-unknown — see
 *     addonRecipeItems' own schema comment for why a costless add-on is
 *     treated as a genuine (not missing) zero, unlike a menu item with no
 *     recipe at all.
 *
 * recipeCostInPaisa is left NULL (not zero, or partially summed) only
 * when NEITHER source applied — no base recipe AND no addon with its own
 * recipe — so a report reading this column can still tell "genuinely free
 * ingredients" apart from "cost unknown, no recipe existed anywhere on
 * this line." A line with a costed addon but no base recipe (or vice
 * versa) is NOT left NULL: whatever cost IS known is captured, same
 * "capture what's known" spirit as the rest of this fix — see
 * getCogsSummary's coverage-flag comment (reports.ts) for how the
 * aggregate-level "partial coverage" signal handles that same case.
 *
 * Commercial-launch Phase A.4 — this is ALSO the one moment
 * orderItems.recipeCostInPaisa gets written: the line's COGS, computed
 * from whatever inventoryItems.costPerUnitInPaisa is right now, then
 * frozen — never recomputed later.
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
    let recipeCostInPaisa = 0;
    let hadAnyCostSource = false;

    if (item.menuItemId) {
      // 10000 basis points = 1x — the default for "no variant selected"
      // AND the default column value for every variant (see
      // menuVariants.recipeQuantityMultiplierBasisPoints), so a plain
      // base-item order behaves identically to before this fix.
      let multiplierBasisPoints = 10000;
      if (item.variantId) {
        const [variant] = await tx
          .select({
            recipeQuantityMultiplierBasisPoints: menuVariants.recipeQuantityMultiplierBasisPoints,
          })
          .from(menuVariants)
          .where(eq(menuVariants.id, item.variantId))
          .limit(1);
        // Variant row may be gone (onDelete: "set null" only prevents a
        // dangling FK going forward — this order's variantId snapshot can
        // still point at an id that existed at order time but was since
        // deleted through a path that predates that constraint, or in a
        // concurrent edge case). Fall back to 1x rather than throwing —
        // same "don't block deduction on a stale menu reference" spirit
        // as skipping a deleted menu item's recipe below.
        if (variant) multiplierBasisPoints = variant.recipeQuantityMultiplierBasisPoints;
      }

      const recipe = await tx
        .select({
          inventoryItemId: recipeItems.inventoryItemId,
          quantityPerServingMilliunits: recipeItems.quantityPerServingMilliunits,
          costPerUnitInPaisa: inventoryItems.costPerUnitInPaisa,
        })
        .from(recipeItems)
        .innerJoin(inventoryItems, eq(inventoryItems.id, recipeItems.inventoryItemId))
        .where(eq(recipeItems.menuItemId, item.menuItemId));

      if (recipe.length > 0) {
        hadAnyCostSource = true;
        for (const line of recipe) {
          // Scale the per-serving quantity by the variant multiplier
          // FIRST (so "2x" means literally double the ingredients of one
          // serving), then multiply by how many were sold — matches the
          // "per serving" naming of quantityPerServingMilliunits.
          const scaledQuantityPerServingMilliunits = Math.round(
            (line.quantityPerServingMilliunits * multiplierBasisPoints) / 10000,
          );
          const deductionMilliunits = scaledQuantityPerServingMilliunits * item.quantity;
          recipeCostInPaisa += Math.round((deductionMilliunits * line.costPerUnitInPaisa) / 1000);
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

    const addonSelections = await tx
      .select({ addonId: orderItemAddons.addonId, nameSnapshot: orderItemAddons.nameSnapshot })
      .from(orderItemAddons)
      .where(eq(orderItemAddons.orderItemId, item.id));

    for (const addon of addonSelections) {
      if (!addon.addonId) continue; // addon deleted since order was placed — same skip as a deleted menu item

      const addonRecipe = await tx
        .select({
          inventoryItemId: addonRecipeItems.inventoryItemId,
          quantityPerServingMilliunits: addonRecipeItems.quantityPerServingMilliunits,
          costPerUnitInPaisa: inventoryItems.costPerUnitInPaisa,
        })
        .from(addonRecipeItems)
        .innerJoin(inventoryItems, eq(inventoryItems.id, addonRecipeItems.inventoryItemId))
        .where(eq(addonRecipeItems.addonId, addon.addonId));

      if (addonRecipe.length === 0) continue; // opt-in — a costless add-on, not a cost gap

      hadAnyCostSource = true;
      for (const line of addonRecipe) {
        // Same per-unit-sold scaling as computeOrderPricing uses for
        // addon PRICE (addonUnitTotal * quantity) — one selection of this
        // addon per unit of the item, deliberately NOT scaled by the
        // item's own variant multiplier (see this function's own doc
        // comment).
        const deductionMilliunits = line.quantityPerServingMilliunits * item.quantity;
        recipeCostInPaisa += Math.round((deductionMilliunits * line.costPerUnitInPaisa) / 1000);
        if (deductionMilliunits === 0) continue;

        await recordStockMovement(tx, {
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          inventoryItemId: line.inventoryItemId,
          type: "sale_deduction",
          quantityDeltaMilliunits: -deductionMilliunits,
          referenceType: "order",
          referenceId: params.orderId,
          note: `${item.quantity}x ${item.menuItemNameSnapshot} (${addon.nameSnapshot})`,
          recordedByUserId: params.recordedByUserId ?? null,
        });
      }
    }

    if (!hadAnyCostSource) continue; // recipeCostInPaisa stays NULL — unknown, not zero

    await tx.update(orderItems).set({ recipeCostInPaisa }).where(eq(orderItems.id, item.id));
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

export type PurchaseExportRow = Awaited<ReturnType<typeof listPurchasesForExport>>[number];

/**
 * Commercial completion pass — Data Export gap (purchases). Same query GET
 * /purchases already runs (supplier + line items eager-loaded, the linked
 * ledgerEntries row batched in for due/paid status — see that route's own
 * comment for why due status lives there and not on the purchase itself),
 * extracted here so the export route can request a higher row limit
 * without duplicating the branch-scoping/ledger-join logic. `branchId ===
 * null` sees every branch's purchases (an unrestricted caller); anything
 * else scopes to that one branch — same convention the route itself uses.
 */
export async function listPurchasesForExport(restaurantId: string, branchId: string | null, limit: number) {
  const rows = await db.query.purchases.findMany({
    where:
      branchId === null
        ? eq(purchases.restaurantId, restaurantId)
        : and(eq(purchases.restaurantId, restaurantId), eq(purchases.branchId, branchId)),
    orderBy: [desc(purchases.createdAt)],
    with: {
      supplier: true,
      branch: true,
      items: { with: { inventoryItem: true } },
    },
    limit,
  });

  const purchaseIds = rows.map((r) => r.id);
  const linkedLedgerEntries =
    purchaseIds.length === 0
      ? []
      : await db
          .select({
            referenceId: ledgerEntries.referenceId,
            amountInPaisa: ledgerEntries.amountInPaisa,
            dueStatus: ledgerEntries.dueStatus,
            settledAmountInPaisa: ledgerEntries.settledAmountInPaisa,
          })
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.restaurantId, restaurantId),
              eq(ledgerEntries.referenceType, "purchase"),
              inArray(ledgerEntries.referenceId, purchaseIds),
            ),
          );
  const ledgerByPurchaseId = new Map(linkedLedgerEntries.map((e) => [e.referenceId, e]));

  return rows.map((r) => ({ ...r, ledgerEntry: ledgerByPurchaseId.get(r.id) ?? null }));
}
