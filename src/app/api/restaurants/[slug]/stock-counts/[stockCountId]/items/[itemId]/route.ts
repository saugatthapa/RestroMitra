import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { stockCounts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { setStockCountItemQuantitySchema } from "@/lib/validation/inventory";
import { setStockCountItemPhysicalQuantity } from "@/lib/stock-count";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** Records (or corrects) the physical quantity found for one line, while the count is still open. */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; stockCountId: string; itemId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, stockCountId, itemId } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const parsed = await parseJsonBody(request, setStockCountItemQuantitySchema);
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
      setStockCountItemPhysicalQuantity(tx, {
        restaurantId,
        stockCountId,
        stockCountItemId: itemId,
        physicalQuantityMilliunits: data.physicalQuantity,
        note: data.note,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_count.item_counted",
      resourceType: "stock_count",
      resourceId: stockCountId,
      ipAddress: getClientIp(request),
      metadata: { itemId, physicalQuantityMilliunits: data.physicalQuantity },
    });

    return NextResponse.json({ item });
  } catch (err) {
    return toErrorResponse(err);
  }
}
