import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { stockCounts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { submitStockCount } from "@/lib/stock-count";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Submits a count: every line must already have a physical quantity. If
 * every variance is within the documented "large variance" thresholds it
 * auto-applies immediately (MANAGE_INVENTORY is sufficient); otherwise it
 * moves to "pending_approval" and needs a caller with APPROVE_STOCK_COUNT
 * to approve or reject — see stock-count.ts's own doc comment.
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
      timezone,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

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

    const result = await db.transaction((tx) =>
      submitStockCount(tx, {
        restaurantId,
        stockCountId,
        submittedByUserId: session.user.id,
        timezone,
        role,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_count.submitted",
      resourceType: "stock_count",
      resourceId: stockCountId,
      ipAddress: getClientIp(request),
      metadata: {
        status: result.stockCount.status,
        appliedMovementCount: result.appliedMovementCount,
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
