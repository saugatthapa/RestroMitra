import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { inventoryItems, suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createInventoryItemSchema } from "@/lib/validation/inventory";
import { unitsToMilliunits } from "@/lib/quantity";
import { isLowStock } from "@/lib/inventory";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const rows = await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.restaurantId, restaurantId))
      .orderBy(asc(inventoryItems.name));

    // isLowStock is derived, not stored — computed fresh on every read so
    // it can never drift from reorderLevelMilliunits/currentStockMilliunits.
    const items = rows.map((item) => ({ ...item, isLowStock: isLowStock(item) }));

    return NextResponse.json({ inventoryItems: items });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const parsed = await parseJsonBody(request, createInventoryItemSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    if (data.preferredSupplierId) {
      const owned = await db
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(and(eq(suppliers.id, data.preferredSupplierId), eq(suppliers.restaurantId, restaurantId)))
        .limit(1);
      if (owned.length === 0) {
        return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
      }
    }

    // Always starts at zero stock, zero cost — see the schema comment on
    // createInventoryItemSchema for why there's no "initial stock" field.
    const [item] = await db
      .insert(inventoryItems)
      .values({
        restaurantId,
        name: data.name,
        unit: data.unit,
        reorderLevelMilliunits:
          data.reorderLevel === null || data.reorderLevel === undefined
            ? null
            : unitsToMilliunits(data.reorderLevel),
        preferredSupplierId: data.preferredSupplierId ?? null,
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.item.created",
      resourceType: "inventory_item",
      resourceId: item.id,
      ipAddress: getClientIp(request),
      metadata: { name: item.name, unit: item.unit },
    });

    return NextResponse.json({ inventoryItem: item }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
