import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { inventoryItems, stockMovements } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { recordStockAdjustmentSchema } from "@/lib/validation/inventory";
import { recordStockMovement } from "@/lib/inventory";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * GET returns the movement ledger for one item (newest first) — the
 * "history" view behind an inventory item's detail screen. Manual
 * adjustments, purchases, and sale-deductions all show up here, since
 * stock_movements is the single ledger for all three.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string }> },
) {
  try {
    const { slug, itemId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const rows = await db
      .select()
      .from(stockMovements)
      .where(
        and(eq(stockMovements.inventoryItemId, itemId), eq(stockMovements.restaurantId, restaurantId)),
      )
      .orderBy(desc(stockMovements.createdAt))
      .limit(100);

    return NextResponse.json({ movements: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Records a manual stock adjustment — count corrections, wastage,
 * spoilage, or recording pre-existing stock right after an item is
 * created. `direction` (add/remove) plus a mandatory `reason` are more
 * honest at the UI layer than asking for a raw signed delta; converted to
 * a signed quantityDeltaMilliunits here before it reaches the ledger.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, itemId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const itemRows = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.restaurantId, restaurantId)))
      .limit(1);
    if (!itemRows[0]) {
      return NextResponse.json({ error: "Inventory item not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, recordStockAdjustmentSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const signedDelta = data.direction === "add" ? data.quantity : -data.quantity;

    const result = await db.transaction(async (tx) =>
      recordStockMovement(tx, {
        restaurantId,
        inventoryItemId: itemId,
        type: "adjustment",
        quantityDeltaMilliunits: signedDelta,
        referenceType: "manual",
        note: data.reason,
        recordedByUserId: session.user.id,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock.adjusted",
      resourceType: "inventory_item",
      resourceId: itemId,
      ipAddress: getClientIp(request),
      metadata: { direction: data.direction, quantityMilliunits: data.quantity, reason: data.reason },
    });

    return NextResponse.json(
      { movement: result.movement, inventoryItem: result.item },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
