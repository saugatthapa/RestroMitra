import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { stockTransfers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { receiveStockTransferSchema } from "@/lib/validation/inventory";
import { receiveStockTransfer } from "@/lib/stock-transfer";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * dispatched -> received. Only the DESTINATION branch's staff receive —
 * they're the ones confirming what actually arrived. `items` is optional
 * per line; an omitted line defaults to "everything dispatched arrived."
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; stockTransferId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, stockTransferId } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const parsed = await parseJsonBody(request, receiveStockTransferSchema);
    if (!parsed.ok) return parsed.response;

    const [existing] = await db
      .select({ id: stockTransfers.id, toBranchId: stockTransfers.toBranchId })
      .from(stockTransfers)
      .where(and(eq(stockTransfers.id, stockTransferId), eq(stockTransfers.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Stock transfer not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.toBranchId, {
      role,
      branchId: grantedBranchId,
    });

    const result = await db.transaction((tx) =>
      receiveStockTransfer(tx, {
        restaurantId,
        stockTransferId,
        receivedByUserId: session.user.id,
        items: parsed.data.items?.map((i) => ({
          stockTransferItemId: i.stockTransferItemId,
          receivedQuantityMilliunits: i.receivedQuantity,
          note: i.note || null,
        })),
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_transfer.received",
      resourceType: "stock_transfer",
      resourceId: stockTransferId,
      ipAddress: getClientIp(request),
      metadata: { receivedLineCount: result.receivedLineCount },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
