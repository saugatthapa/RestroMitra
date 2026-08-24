import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { stockTransfers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireEitherBranchAccess } from "@/lib/rbac/guard";
import { approveStockTransfer } from "@/lib/stock-transfer";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** requested -> approved. Either branch's staff (or an unrestricted role) may sign off. */
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
      approveStockTransfer(tx, { restaurantId, stockTransferId, approvedByUserId: session.user.id }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_transfer.approved",
      resourceType: "stock_transfer",
      resourceId: stockTransferId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ transfer });
  } catch (err) {
    return toErrorResponse(err);
  }
}
