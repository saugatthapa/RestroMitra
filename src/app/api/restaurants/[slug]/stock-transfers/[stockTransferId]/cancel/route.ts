import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { stockTransfers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireEitherBranchAccess } from "@/lib/rbac/guard";
import { cancelStockTransferSchema } from "@/lib/validation/inventory";
import { cancelStockTransfer } from "@/lib/stock-transfer";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** requested/approved -> cancelled. Only available before dispatch — see cancelStockTransfer's own doc comment. */
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

    const parsed = await parseJsonBody(request, cancelStockTransferSchema);
    if (!parsed.ok) return parsed.response;

    const [existing] = await db
      .select({ id: stockTransfers.id, fromBranchId: stockTransfers.fromBranchId, toBranchId: stockTransfers.toBranchId })
      .from(stockTransfers)
      .where(and(eq(stockTransfers.id, stockTransferId), eq(stockTransfers.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Stock transfer not found." }, { status: 404 });
    }
    await requireEitherBranchAccess(session.user.id, restaurantId, existing.fromBranchId, existing.toBranchId, {
      role,
      branchId: grantedBranchId,
    });

    const transfer = await db.transaction((tx) =>
      cancelStockTransfer(tx, {
        restaurantId,
        stockTransferId,
        cancelledByUserId: session.user.id,
        reason: parsed.data.reason,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_transfer.cancelled",
      resourceType: "stock_transfer",
      resourceId: stockTransferId,
      ipAddress: getClientIp(request),
      metadata: { reason: parsed.data.reason },
    });

    return NextResponse.json({ transfer });
  } catch (err) {
    return toErrorResponse(err);
  }
}
