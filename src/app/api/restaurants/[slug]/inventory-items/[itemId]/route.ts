import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { inventoryItems, suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateInventoryItemSchema } from "@/lib/validation/inventory";
import { unitsToMilliunits } from "@/lib/quantity";
import { isLowStock } from "@/lib/inventory";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedItem(restaurantId: string, itemId: string) {
  const rows = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

// No DELETE — deactivate via PATCH { isActive: false }. Stock/cost fields
// (currentStockMilliunits, costPerUnitInPaisa) are deliberately absent from
// updateInventoryItemSchema: they're cached/derived and can only change
// through recordStockMovement()/applyPurchaseCosting() (purchases,
// adjustments, order-driven deductions), never a direct field edit.
export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/inventory-items/[itemId]">,
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

    const existing = await getOwnedItem(restaurantId, itemId);
    if (!existing) {
      return NextResponse.json({ error: "Inventory item not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateInventoryItemSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "No changes provided." }, { status: 400 });
    }

    if (data.preferredSupplierId) {
      const owned = await db
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(
          and(eq(suppliers.id, data.preferredSupplierId), eq(suppliers.restaurantId, restaurantId)),
        )
        .limit(1);
      if (owned.length === 0) {
        return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
      }
    }

    const { reorderLevel, ...rest } = data;
    const [updated] = await db
      .update(inventoryItems)
      .set({
        ...rest,
        ...(reorderLevel !== undefined
          ? { reorderLevelMilliunits: reorderLevel === null ? null : unitsToMilliunits(reorderLevel) }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.item.updated",
      resourceType: "inventory_item",
      resourceId: itemId,
      ipAddress: getClientIp(request),
      metadata: { fields: Object.keys(data) },
    });

    return NextResponse.json({ inventoryItem: { ...updated, isLowStock: isLowStock(updated) } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
