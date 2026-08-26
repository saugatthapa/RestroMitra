import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import {
  branchInventoryLevels,
  branches,
  inventoryItems,
  stockCountItems,
  stockCounts,
} from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { recordStockMovement } from "@/lib/inventory";
import { restaurantDate } from "@/lib/restaurant-date";
import { assertBusinessDayWritable } from "@/lib/daily-closing";

export class StockCountError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

/**
 * "Large variance" thresholds (Commercial Launch Phase A.6) — a variance
 * exceeding EITHER trips the auto-apply-vs-require-approval decision (see
 * submitStockCount below). Deliberately fixed, documented constants rather
 * than a per-restaurant setting: the spec doesn't ask for a configurable
 * threshold, and adding one now would be scope creep this phase doesn't
 * need — a real restaurant can adjust its counting discipline (count more
 * often, count in smaller batches) far more easily than this code can
 * guess the "right" number for every kitchen. Revisit if real usage shows
 * these numbers are wrong for most tenants.
 *
 * A variance counts as "large" if its absolute paisa value exceeds
 * LARGE_VARIANCE_VALUE_THRESHOLD_PAISA, OR (when the system quantity being
 * compared against is positive) its magnitude is more than
 * LARGE_VARIANCE_PERCENT_THRESHOLD of that system quantity. Either
 * condition alone can flag a line: a 15% shortfall on a cheap sack of
 * onions is still worth a second pair of eyes even though the rupee value
 * is small, and a 2% shortfall on an expensive case of imported liquor can
 * still be a large rupee loss even though the percentage is small.
 */
export const LARGE_VARIANCE_VALUE_THRESHOLD_PAISA = 50_000; // NPR 500
export const LARGE_VARIANCE_PERCENT_THRESHOLD = 0.1; // 10%

/** physical - system, in the item's own milliunits. Positive = found more than expected (overage); negative = found less (shrinkage). */
export function computeVarianceMilliunits(
  systemQuantityMilliunits: number,
  physicalQuantityMilliunits: number,
): number {
  return physicalQuantityMilliunits - systemQuantityMilliunits;
}

/** The variance's value at the line's frozen cost snapshot, in paisa. Sign matches the variance (negative = a loss). */
export function computeVarianceValueInPaisa(
  varianceMilliunits: number,
  unitCostInPaisaSnapshot: number,
): number {
  return Math.round((varianceMilliunits * unitCostInPaisaSnapshot) / 1000);
}

export function isLargeVariance(params: {
  varianceMilliunits: number;
  systemQuantityMilliunits: number;
  unitCostInPaisaSnapshot: number;
}): boolean {
  if (params.varianceMilliunits === 0) return false;
  const valueInPaisa = Math.abs(
    computeVarianceValueInPaisa(params.varianceMilliunits, params.unitCostInPaisaSnapshot),
  );
  if (valueInPaisa > LARGE_VARIANCE_VALUE_THRESHOLD_PAISA) return true;
  if (params.systemQuantityMilliunits > 0) {
    const percent = Math.abs(params.varianceMilliunits) / params.systemQuantityMilliunits;
    if (percent > LARGE_VARIANCE_PERCENT_THRESHOLD) return true;
  }
  return false;
}

export type StockCountItemWithVariance = typeof stockCountItems.$inferSelect & {
  varianceMilliunits: number | null;
  varianceValueInPaisa: number | null;
  isLarge: boolean;
};

function withVariance(item: typeof stockCountItems.$inferSelect): StockCountItemWithVariance {
  if (item.physicalQuantityMilliunits === null) {
    return { ...item, varianceMilliunits: null, varianceValueInPaisa: null, isLarge: false };
  }
  const varianceMilliunits = computeVarianceMilliunits(
    item.systemQuantityMilliunits,
    item.physicalQuantityMilliunits,
  );
  const varianceValueInPaisa = computeVarianceValueInPaisa(varianceMilliunits, item.unitCostInPaisaSnapshot);
  return {
    ...item,
    varianceMilliunits,
    varianceValueInPaisa,
    isLarge: isLargeVariance({
      varianceMilliunits,
      systemQuantityMilliunits: item.systemQuantityMilliunits,
      unitCostInPaisaSnapshot: item.unitCostInPaisaSnapshot,
    }),
  };
}

/** Creates a new, empty (status="open") stock count for one branch. Items are added afterward via addStockCountItem. */
export async function createStockCount(params: {
  restaurantId: string;
  branchId: string;
  countedByUserId: string;
  notes?: string | null;
}) {
  const branchRows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, params.branchId), eq(branches.restaurantId, params.restaurantId)))
    .limit(1);
  if (!branchRows[0]) {
    throw new StockCountError("Branch not found.", 404);
  }

  const [count] = await db
    .insert(stockCounts)
    .values({
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      countedByUserId: params.countedByUserId,
      notes: params.notes || null,
    })
    .returning();
  return count;
}

/**
 * Adds one inventory item to an open count, freezing its system-quantity
 * and unit-cost snapshots at this moment (see this module's schema-section
 * comment in schema.ts for why). Locks the count header row first so this
 * can't race a concurrent submitStockCount — see that function's own
 * comment on why the lock is taken there too.
 */
export async function addStockCountItem(
  tx: Transaction,
  params: {
    restaurantId: string;
    stockCountId: string;
    inventoryItemId: string;
    physicalQuantityMilliunits?: number | null;
    note?: string | null;
  },
) {
  const [count] = await tx
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.id, params.stockCountId), eq(stockCounts.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  if (!count) {
    throw new StockCountError("Stock count not found.", 404);
  }
  if (count.status !== "open") {
    throw new StockCountError("This stock count has already been submitted and can no longer be edited.", 409);
  }

  const [item] = await tx
    .select({ id: inventoryItems.id, costPerUnitInPaisa: inventoryItems.costPerUnitInPaisa })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, params.inventoryItemId), eq(inventoryItems.restaurantId, params.restaurantId)))
    .limit(1);
  if (!item) {
    throw new StockCountError("Inventory item not found.", 404);
  }

  const [branchLevel] = await tx
    .select({ currentStockMilliunits: branchInventoryLevels.currentStockMilliunits })
    .from(branchInventoryLevels)
    .where(
      and(
        eq(branchInventoryLevels.branchId, count.branchId),
        eq(branchInventoryLevels.inventoryItemId, params.inventoryItemId),
      ),
    )
    .limit(1);
  const systemQuantityMilliunits = branchLevel?.currentStockMilliunits ?? 0;

  const [inserted] = await tx
    .insert(stockCountItems)
    .values({
      stockCountId: params.stockCountId,
      inventoryItemId: params.inventoryItemId,
      systemQuantityMilliunits,
      unitCostInPaisaSnapshot: item.costPerUnitInPaisa,
      physicalQuantityMilliunits: params.physicalQuantityMilliunits ?? null,
      note: params.note || null,
      countedAt: params.physicalQuantityMilliunits != null ? new Date() : null,
    })
    .onConflictDoNothing({ target: [stockCountItems.stockCountId, stockCountItems.inventoryItemId] })
    .returning();
  if (!inserted) {
    throw new StockCountError("This item has already been added to this count.", 409);
  }
  return inserted;
}

/** Records (or corrects) the physical quantity found for one line, while the count is still open. */
export async function setStockCountItemPhysicalQuantity(
  tx: Transaction,
  params: {
    restaurantId: string;
    stockCountId: string;
    stockCountItemId: string;
    physicalQuantityMilliunits: number;
    note?: string | null;
  },
) {
  const [count] = await tx
    .select({ id: stockCounts.id, status: stockCounts.status })
    .from(stockCounts)
    .where(and(eq(stockCounts.id, params.stockCountId), eq(stockCounts.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  if (!count) {
    throw new StockCountError("Stock count not found.", 404);
  }
  if (count.status !== "open") {
    throw new StockCountError("This stock count has already been submitted and can no longer be edited.", 409);
  }

  const [updated] = await tx
    .update(stockCountItems)
    .set({
      physicalQuantityMilliunits: params.physicalQuantityMilliunits,
      note: params.note === undefined ? undefined : params.note || null,
      countedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(stockCountItems.id, params.stockCountItemId), eq(stockCountItems.stockCountId, params.stockCountId)),
    )
    .returning();
  if (!updated) {
    throw new StockCountError("Stock count line item not found.", 404);
  }
  return updated;
}

async function applyVariances(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    stockCountId: string;
    recordedByUserId: string;
    timezone: string;
    role?: string;
  },
) {
  // QA hardening pass (Phase 5 / centralized daily-close lock) — a stock
  // count's variances land in stockAdjustmentNetValueChangeInPaisa, read
  // straight into the Daily Closing snapshot exactly like a manual
  // adjustment does (see getStockAdjustmentsSummary) — same lock, applied
  // once here since this is the ONE place either submitStockCount's
  // auto-apply path or approveStockCount's approval path actually writes a
  // stock movement, rather than duplicating the check in both routes.
  // Always "now" — a count is finalized at the moment it's submitted or
  // approved, not backdated.
  await assertBusinessDayWritable(
    {
      userId: params.recordedByUserId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      businessDate: restaurantDate(params.timezone),
      role: params.role,
    },
    tx,
  );

  const items = await tx.select().from(stockCountItems).where(eq(stockCountItems.stockCountId, params.stockCountId));
  let appliedCount = 0;
  for (const item of items) {
    if (item.physicalQuantityMilliunits === null) continue; // shouldn't happen — submit() already required every line to be counted
    const variance = computeVarianceMilliunits(item.systemQuantityMilliunits, item.physicalQuantityMilliunits);
    if (variance === 0) continue;
    await recordStockMovement(tx, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      inventoryItemId: item.inventoryItemId,
      type: "adjustment",
      quantityDeltaMilliunits: variance,
      referenceType: "stock_count",
      referenceId: params.stockCountId,
      note: "Physical stock count variance",
      recordedByUserId: params.recordedByUserId,
    });
    appliedCount += 1;
  }
  return appliedCount;
}

/**
 * Submits a count for finalization: every line must have a physical
 * quantity recorded. If every line's variance is within the "large
 * variance" thresholds, the count auto-applies immediately (status
 * "applied") — MANAGE_INVENTORY is sufficient trust for ordinary counting
 * noise. If ANY line exceeds the threshold, nothing is applied yet; the
 * count moves to "pending_approval" and needs APPROVE_STOCK_COUNT to
 * either approve (apply) or reject (discard) — see this module's own
 * segregation-of-duties reasoning in permissions.ts.
 *
 * Locks the count header row FOR UPDATE for the whole operation — the same
 * lock addStockCountItem/setStockCountItemPhysicalQuantity take before
 * touching this row, so a line can't be edited out from under a submit
 * that's already reading it, and two concurrent submits of the same count
 * can't both succeed (the CAS update below is defense in depth on top of
 * that lock, matching this codebase's existing convention — see
 * voidPurchase).
 */
export async function submitStockCount(
  tx: Transaction,
  params: {
    restaurantId: string;
    stockCountId: string;
    submittedByUserId: string;
    timezone: string;
    role?: string;
  },
) {
  const [count] = await tx
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.id, params.stockCountId), eq(stockCounts.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  if (!count) {
    throw new StockCountError("Stock count not found.", 404);
  }
  if (count.status !== "open") {
    throw new StockCountError("This stock count has already been submitted.", 409);
  }

  const items = await tx.select().from(stockCountItems).where(eq(stockCountItems.stockCountId, params.stockCountId));
  if (items.length === 0) {
    throw new StockCountError("Add at least one item before submitting.");
  }
  const uncounted = items.some((item) => item.physicalQuantityMilliunits === null);
  if (uncounted) {
    throw new StockCountError("Enter a physical count for every item before submitting.");
  }

  const hasLargeVariance = items.some((item) => {
    const variance = computeVarianceMilliunits(
      item.systemQuantityMilliunits,
      item.physicalQuantityMilliunits as number,
    );
    return isLargeVariance({
      varianceMilliunits: variance,
      systemQuantityMilliunits: item.systemQuantityMilliunits,
      unitCostInPaisaSnapshot: item.unitCostInPaisaSnapshot,
    });
  });

  const now = new Date();
  if (hasLargeVariance) {
    const [updated] = await tx
      .update(stockCounts)
      .set({ status: "pending_approval", submittedAt: now, hasLargeVariance: true, updatedAt: now })
      .where(and(eq(stockCounts.id, params.stockCountId), eq(stockCounts.status, "open")))
      .returning();
    if (!updated) {
      throw new StockCountError("This stock count was just submitted by someone else. Please refresh and try again.", 409);
    }
    return { stockCount: updated, appliedMovementCount: 0 };
  }

  const appliedMovementCount = await applyVariances(tx, {
    restaurantId: params.restaurantId,
    branchId: count.branchId,
    stockCountId: params.stockCountId,
    recordedByUserId: params.submittedByUserId,
    timezone: params.timezone,
    role: params.role,
  });

  const [updated] = await tx
    .update(stockCounts)
    .set({ status: "applied", submittedAt: now, appliedAt: now, hasLargeVariance: false, updatedAt: now })
    .where(and(eq(stockCounts.id, params.stockCountId), eq(stockCounts.status, "open")))
    .returning();
  if (!updated) {
    throw new StockCountError("This stock count was just submitted by someone else. Please refresh and try again.", 409);
  }
  return { stockCount: updated, appliedMovementCount };
}

/** Approves a pending-approval count: writes every line's variance to the stock ledger and marks the count applied. */
export async function approveStockCount(
  tx: Transaction,
  params: {
    restaurantId: string;
    stockCountId: string;
    approvedByUserId: string;
    timezone: string;
    role?: string;
  },
) {
  const [count] = await tx
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.id, params.stockCountId), eq(stockCounts.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  if (!count) {
    throw new StockCountError("Stock count not found.", 404);
  }
  if (count.status !== "pending_approval") {
    throw new StockCountError("This stock count is not awaiting approval.", 409);
  }

  const appliedMovementCount = await applyVariances(tx, {
    restaurantId: params.restaurantId,
    branchId: count.branchId,
    stockCountId: params.stockCountId,
    recordedByUserId: params.approvedByUserId,
    timezone: params.timezone,
    role: params.role,
  });

  const now = new Date();
  const [updated] = await tx
    .update(stockCounts)
    .set({ status: "applied", approvedByUserId: params.approvedByUserId, approvedAt: now, appliedAt: now, updatedAt: now })
    .where(and(eq(stockCounts.id, params.stockCountId), eq(stockCounts.status, "pending_approval")))
    .returning();
  if (!updated) {
    throw new StockCountError("This stock count was just resolved by someone else. Please refresh and try again.", 409);
  }
  return { stockCount: updated, appliedMovementCount };
}

/** Rejects a pending-approval count: no stock movement is ever written. The count row is kept, marked "rejected", for the audit trail. */
export async function rejectStockCount(
  tx: Transaction,
  params: { restaurantId: string; stockCountId: string; rejectedByUserId: string; reason: string },
) {
  const [count] = await tx
    .select({ id: stockCounts.id, status: stockCounts.status })
    .from(stockCounts)
    .where(and(eq(stockCounts.id, params.stockCountId), eq(stockCounts.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  if (!count) {
    throw new StockCountError("Stock count not found.", 404);
  }
  if (count.status !== "pending_approval") {
    throw new StockCountError("This stock count is not awaiting approval.", 409);
  }

  const now = new Date();
  const [updated] = await tx
    .update(stockCounts)
    .set({
      status: "rejected",
      rejectedByUserId: params.rejectedByUserId,
      rejectedAt: now,
      rejectionReason: params.reason,
      updatedAt: now,
    })
    .where(and(eq(stockCounts.id, params.stockCountId), eq(stockCounts.status, "pending_approval")))
    .returning();
  if (!updated) {
    throw new StockCountError("This stock count was just resolved by someone else. Please refresh and try again.", 409);
  }
  return updated;
}

/** One count's header plus its line items, each with variance/varianceValue/isLarge computed. */
export async function getStockCountDetail(restaurantId: string, stockCountId: string) {
  const [count] = await db
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.restaurantId, restaurantId)))
    .limit(1);
  if (!count) {
    throw new StockCountError("Stock count not found.", 404);
  }
  const items = await db.select().from(stockCountItems).where(eq(stockCountItems.stockCountId, stockCountId));
  return { stockCount: count, items: items.map(withVariance) };
}

// QA hardening pass (pagination audit) — every other list route in this
// codebase enforces a hard cap (orders' ORDER_LIST_LIMIT, expenses'
// EXPENSE_LIST_LIMIT, audit-log's MAX_LIST_LIMIT, etc.); this one had none
// at all, unbounded and growing with every physical count a restaurant has
// ever run.
const STOCK_COUNT_LIST_LIMIT = 200;

export async function listStockCounts(
  restaurantId: string,
  filters: { branchId?: string; status?: (typeof stockCounts.$inferSelect)["status"] } = {},
) {
  const conditions = [eq(stockCounts.restaurantId, restaurantId)];
  if (filters.branchId) conditions.push(eq(stockCounts.branchId, filters.branchId));
  if (filters.status) conditions.push(eq(stockCounts.status, filters.status));
  return db
    .select()
    .from(stockCounts)
    .where(and(...conditions))
    .orderBy(desc(stockCounts.createdAt))
    .limit(STOCK_COUNT_LIST_LIMIT);
}
