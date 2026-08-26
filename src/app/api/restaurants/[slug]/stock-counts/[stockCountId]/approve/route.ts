import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { stockCounts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { approveStockCount } from "@/lib/stock-count";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Approves a pending-approval count: writes every line's variance to the
 * stock ledger. Gated behind APPROVE_STOCK_COUNT — deliberately a separate,
 * higher-trust permission from MANAGE_INVENTORY (which only gets you to
 * "submitted, awaiting approval" for a large variance) — see that
 * permission's own comment in permissions.ts for the segregation-of-duties
 * reasoning.
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
    } = await resolveRestaurantContext(slug, PERMISSIONS.APPROVE_STOCK_COUNT);

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
      approveStockCount(tx, {
        restaurantId,
        stockCountId,
        approvedByUserId: session.user.id,
        timezone,
        role,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_count.approved",
      resourceType: "stock_count",
      resourceId: stockCountId,
      ipAddress: getClientIp(request),
      metadata: { appliedMovementCount: result.appliedMovementCount },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
