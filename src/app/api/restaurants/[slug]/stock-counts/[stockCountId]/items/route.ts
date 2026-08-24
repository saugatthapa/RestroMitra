import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { stockCounts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { addStockCountItemSchema } from "@/lib/validation/inventory";
import { addStockCountItem } from "@/lib/stock-count";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Adds one inventory item to an open count — freezing its system-quantity
 * and unit-cost snapshots at this moment (see stock-count.ts). Optionally
 * records the physical quantity in the same call (the common "walk the
 * shelf, scan/tap the item, type what you see" flow); otherwise it can be
 * set afterward via PATCH items/[itemId].
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; stockCountId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, stockCountId } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const parsed = await parseJsonBody(request, addStockCountItemSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const [existing] = await db
      .select({ id: stockCounts.id, branchId: stockCounts.branchId })
      .from(stockCounts)
      .where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Stock count not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const item = await db.transaction((tx) =>
      addStockCountItem(tx, {
        restaurantId,
        stockCountId,
        inventoryItemId: data.inventoryItemId,
        physicalQuantityMilliunits: data.physicalQuantity ?? null,
        note: data.note || null,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_count.item_added",
      resourceType: "stock_count",
      resourceId: stockCountId,
      ipAddress: getClientIp(request),
      metadata: { inventoryItemId: data.inventoryItemId },
    });

    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
