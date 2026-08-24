import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { stockTransfers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { dispatchStockTransfer } from "@/lib/stock-transfer";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * approved -> dispatched. Only the SOURCE branch's staff dispatch — they're
 * the ones physically handing the goods over, and this is the step that
 * actually deducts stock there.
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

    const [existing] = await db
      .select({ id: stockTransfers.id, fromBranchId: stockTransfers.fromBranchId })
      .from(stockTransfers)
      .where(and(eq(stockTransfers.id, stockTransferId), eq(stockTransfers.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Stock transfer not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.fromBranchId, {
      role,
      branchId: grantedBranchId,
    });

    const result = await db.transaction((tx) =>
      dispatchStockTransfer(tx, { restaurantId, stockTransferId, dispatchedByUserId: session.user.id }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_transfer.dispatched",
      resourceType: "stock_transfer",
      resourceId: stockTransferId,
      ipAddress: getClientIp(request),
      metadata: { dispatchedItemCount: result.dispatchedItemCount },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
