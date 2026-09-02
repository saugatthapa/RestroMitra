import "server-only";
import { and, desc, eq, or } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import { branches, inventoryItems, stockTransferItems, stockTransfers } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { recordStockMovement } from "@/lib/inventory";

export class StockTransferError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

/**
 * Creates a new transfer request (status "requested") for one or more
 * inventory items, from one branch to another of the same restaurant. No
 * stock moves yet — that only happens at dispatch/receive (see this
 * module's own functions below and the schema-section comment in
 * schema.ts). Manages its own transaction (header + every line insert
 * together) since, unlike the rest of this module's functions, there is no
 * existing row to lock first — creation is the one operation here that
 * doesn't need FOR UPDATE.
 */
export async function createStockTransfer(params: {
  restaurantId: string;
  fromBranchId: string;
  toBranchId: string;
  requestedByUserId: string;
  notes?: string | null;
  items: { inventoryItemId: string; quantityMilliunits: number }[];
}) {
  if (params.fromBranchId === params.toBranchId) {
    throw new StockTransferError("The source and destination branch must be different.");
  }
  if (params.items.length === 0) {
    throw new StockTransferError("Add at least one item to transfer.");
  }

  const branchRows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(
      and(
        eq(branches.restaurantId, params.restaurantId),
        or(eq(branches.id, params.fromBranchId), eq(branches.id, params.toBranchId)),
      ),
    );
  const foundBranchIds = new Set(branchRows.map((b) => b.id));
  if (!foundBranchIds.has(params.fromBranchId) || !foundBranchIds.has(params.toBranchId)) {
    throw new StockTransferError("Branch not found.", 404);
  }

  const itemIds = params.items.map((i) => i.inventoryItemId);
  if (new Set(itemIds).size !== itemIds.length) {
    throw new StockTransferError("Each item can only appear once in a transfer.");
  }
  const ownedItems = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(eq(inventoryItems.restaurantId, params.restaurantId));
  const ownedItemIds = new Set(ownedItems.map((i) => i.id));
  for (const line of params.items) {
    if (!ownedItemIds.has(line.inventoryItemId)) {
      throw new StockTransferError("Inventory item not found.", 404);
    }
    if (line.quantityMilliunits <= 0) {
      throw new StockTransferError("Every line's quantity must be greater than zero.");
    }
  }

  return db.transaction(async (tx) => {
    const [transfer] = await tx
      .insert(stockTransfers)
      .values({
        restaurantId: params.restaurantId,
        fromBranchId: params.fromBranchId,
        toBranchId: params.toBranchId,
        requestedByUserId: params.requestedByUserId,
        notes: params.notes || null,
      })
      .returning();

    const items = [];
    for (const line of params.items) {
      const [item] = await tx
        .insert(stockTransferItems)
        .values({
          stockTransferId: transfer.id,
          inventoryItemId: line.inventoryItemId,
          quantityMilliunits: line.quantityMilliunits,
        })
        .returning();
      items.push(item);
    }

    return { transfer, items };
  });
}

async function lockTransfer(tx: Transaction, restaurantId: string, stockTransferId: string) {
  const [transfer] = await tx
    .select()
    .from(stockTransfers)
    .where(and(eq(stockTransfers.id, stockTransferId), eq(stockTransfers.restaurantId, restaurantId)))
    .for("update")
    .limit(1);
  if (!transfer) {
    throw new StockTransferError("Stock transfer not found.", 404);
  }
  return transfer;
}

/** requested -> approved. A sign-off step; no stock movement yet. */
export async function approveStockTransfer(
  tx: Transaction,
  params: { restaurantId: string; stockTransferId: string; approvedByUserId: string },
) {
  const transfer = await lockTransfer(tx, params.restaurantId, params.stockTransferId);
  if (transfer.status !== "requested") {
    throw new StockTransferError("This transfer is not awaiting approval.", 409);
  }
  const now = new Date();
  const [updated] = await tx
    .update(stockTransfers)
    .set({ status: "approved", approvedByUserId: params.approvedByUserId, approvedAt: now, updatedAt: now })
    .where(and(eq(stockTransfers.id, params.stockTransferId), eq(stockTransfers.status, "requested")))
    .returning();
  if (!updated) {
    throw new StockTransferError("This transfer was just updated by someone else. Please refresh and try again.", 409);
  }
  return updated;
}

/**
 * approved -> dispatched. The moment stock actually leaves the source
 * branch: writes one "transfer_out" stock movement per line (negative
 * delta, at fromBranchId), each frozen with its own cost snapshot by
 * recordStockMovement exactly like every other movement type. Stock is
 * allowed to go negative here, same as everywhere else in this codebase
 * (purchases/waste/adjustments) — dispatch doesn't block on "insufficient
 * stock," it just records what actually happened — UNLESS the restaurant
 * has turned on hard enforcement (restaurants.allowNegativeStock = false),
 * in which case recordStockMovement itself rejects a dispatch that would
 * take the source branch negative (see that function's own comment).
 */
export async function dispatchStockTransfer(
  tx: Transaction,
  params: { restaurantId: string; stockTransferId: string; dispatchedByUserId: string },
) {
  const transfer = await lockTransfer(tx, params.restaurantId, params.stockTransferId);
  if (transfer.status !== "approved") {
    throw new StockTransferError("This transfer must be approved before it can be dispatched.", 409);
  }

  const items = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.stockTransferId, transfer.id));
  for (const item of items) {
    await recordStockMovement(tx, {
      restaurantId: params.restaurantId,
      branchId: transfer.fromBranchId,
      inventoryItemId: item.inventoryItemId,
      type: "transfer_out",
      quantityDeltaMilliunits: -item.quantityMilliunits,
      referenceType: "stock_transfer",
      referenceId: transfer.id,
      note: "Stock transfer dispatched",
      recordedByUserId: params.dispatchedByUserId,
    });
  }

  const now = new Date();
  const [updated] = await tx
    .update(stockTransfers)
    .set({ status: "dispatched", dispatchedByUserId: params.dispatchedByUserId, dispatchedAt: now, updatedAt: now })
    .where(and(eq(stockTransfers.id, params.stockTransferId), eq(stockTransfers.status, "approved")))
    .returning();
  if (!updated) {
    throw new StockTransferError("This transfer was just updated by someone else. Please refresh and try again.", 409);
  }
  return { transfer: updated, dispatchedItemCount: items.length };
}

/**
 * dispatched -> received. Writes one "transfer_in" stock movement per line
 * (positive delta, at toBranchId) using whatever quantity actually
 * arrived — see stockTransferItems.receivedQuantityMilliunits' own schema
 * comment. Terminal: a received transfer can't be cancelled or re-received
 * (the CAS update below rejects a second call, same pattern as every other
 * finalize-once operation in this codebase).
 */
export async function receiveStockTransfer(
  tx: Transaction,
  params: {
    restaurantId: string;
    stockTransferId: string;
    receivedByUserId: string;
    items?: { stockTransferItemId: string; receivedQuantityMilliunits: number; note?: string | null }[];
  },
) {
  const transfer = await lockTransfer(tx, params.restaurantId, params.stockTransferId);
  if (transfer.status !== "dispatched") {
    throw new StockTransferError("This transfer must be dispatched before it can be received.", 409);
  }

  const lines = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.stockTransferId, transfer.id));
  const overrides = new Map((params.items ?? []).map((o) => [o.stockTransferItemId, o]));
  const linesById = new Map(lines.map((l) => [l.id, l]));
  for (const override of overrides.values()) {
    if (override.receivedQuantityMilliunits < 0) {
      throw new StockTransferError("Received quantity can't be negative.");
    }
    // QA hardening pass (Phase 7 / master prompt section 10) — nothing
    // previously stopped a received quantity from exceeding what was
    // actually dispatched. Since dispatch already wrote the negative
    // "transfer_out" movement at the source branch for exactly
    // line.quantityMilliunits (see dispatchStockTransfer above), a
    // received amount greater than that would credit the destination
    // branch with stock that was never actually sent — manufacturing
    // inventory out of nowhere, not merely mis-recording a real transfer.
    // A stockTransferItemId that doesn't match any of this transfer's own
    // lines is a separate, pre-existing validation concern (falls through
    // to the "not found" branch inside the loop below), so this only
    // checks overrides that DO match a real line here.
    const line = linesById.get(override.stockTransferItemId);
    if (line && override.receivedQuantityMilliunits > line.quantityMilliunits) {
      throw new StockTransferError(
        `Received quantity (${override.receivedQuantityMilliunits / 1000}) can't exceed what was dispatched (${line.quantityMilliunits / 1000}).`,
      );
    }
  }

  let receivedLineCount = 0;
  for (const line of lines) {
    const override = overrides.get(line.id);
    // Defaults to the full dispatched quantity — the common case where
    // everything that left arrived intact.
    const receivedQuantityMilliunits = override ? override.receivedQuantityMilliunits : line.quantityMilliunits;

    await tx
      .update(stockTransferItems)
      .set({
        receivedQuantityMilliunits,
        note: override?.note !== undefined ? override.note || null : undefined,
        updatedAt: new Date(),
      })
      .where(eq(stockTransferItems.id, line.id));

    if (receivedQuantityMilliunits > 0) {
      await recordStockMovement(tx, {
        restaurantId: params.restaurantId,
        branchId: transfer.toBranchId,
        inventoryItemId: line.inventoryItemId,
        type: "transfer_in",
        quantityDeltaMilliunits: receivedQuantityMilliunits,
        referenceType: "stock_transfer",
        referenceId: transfer.id,
        note: "Stock transfer received",
        recordedByUserId: params.receivedByUserId,
      });
      receivedLineCount += 1;
    }
  }

  const now = new Date();
  const [updated] = await tx
    .update(stockTransfers)
    .set({ status: "received", receivedByUserId: params.receivedByUserId, receivedAt: now, updatedAt: now })
    .where(and(eq(stockTransfers.id, params.stockTransferId), eq(stockTransfers.status, "dispatched")))
    .returning();
  if (!updated) {
    throw new StockTransferError("This transfer was just updated by someone else. Please refresh and try again.", 409);
  }
  return { transfer: updated, receivedLineCount };
}

/**
 * requested/approved -> cancelled. See this module's schema-section
 * comment for why cancel is unavailable once dispatched.
 */
export async function cancelStockTransfer(
  tx: Transaction,
  params: { restaurantId: string; stockTransferId: string; cancelledByUserId: string; reason: string },
) {
  const transfer = await lockTransfer(tx, params.restaurantId, params.stockTransferId);
  if (transfer.status !== "requested" && transfer.status !== "approved") {
    throw new StockTransferError(
      transfer.status === "dispatched" || transfer.status === "received"
        ? "This transfer has already been dispatched and can no longer be cancelled — receive it instead."
        : "This transfer has already been cancelled.",
      409,
    );
  }
  const now = new Date();
  const [updated] = await tx
    .update(stockTransfers)
    .set({
      status: "cancelled",
      cancelledByUserId: params.cancelledByUserId,
      cancelledAt: now,
      cancellationReason: params.reason,
      updatedAt: now,
    })
    .where(and(eq(stockTransfers.id, params.stockTransferId), or(eq(stockTransfers.status, "requested"), eq(stockTransfers.status, "approved"))))
    .returning();
  if (!updated) {
    throw new StockTransferError("This transfer was just updated by someone else. Please refresh and try again.", 409);
  }
  return updated;
}

export async function getStockTransferDetail(restaurantId: string, stockTransferId: string) {
  const [transfer] = await db
    .select()
    .from(stockTransfers)
    .where(and(eq(stockTransfers.id, stockTransferId), eq(stockTransfers.restaurantId, restaurantId)))
    .limit(1);
  if (!transfer) {
    throw new StockTransferError("Stock transfer not found.", 404);
  }
  const items = await db.select().from(stockTransferItems).where(eq(stockTransferItems.stockTransferId, stockTransferId));
  return { transfer, items };
}

// QA hardening pass (pagination audit) — same gap, same fix as
// listStockCounts: this list had no cap at all.
const STOCK_TRANSFER_LIST_LIMIT = 200;

export async function listStockTransfers(
  restaurantId: string,
  filters: { branchId?: string; status?: (typeof stockTransfers.$inferSelect)["status"] } = {},
) {
  const conditions = [eq(stockTransfers.restaurantId, restaurantId)];
  // A branch cares about transfers both coming and going.
  if (filters.branchId) {
    conditions.push(or(eq(stockTransfers.fromBranchId, filters.branchId), eq(stockTransfers.toBranchId, filters.branchId))!);
  }
  if (filters.status) conditions.push(eq(stockTransfers.status, filters.status));
  return db
    .select()
    .from(stockTransfers)
    .where(and(...conditions))
    .orderBy(desc(stockTransfers.createdAt))
    .limit(STOCK_TRANSFER_LIST_LIMIT);
}
