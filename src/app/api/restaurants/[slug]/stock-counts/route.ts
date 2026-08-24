import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { createStockCountSchema } from "@/lib/validation/inventory";
import { createStockCount, listStockCounts } from "@/lib/stock-count";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const STATUS_VALUES = ["open", "pending_approval", "applied", "rejected"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

/**
 * Physical Stock Count (Commercial Launch Phase A.6). Gated behind
 * MANAGE_INVENTORY — same trust tier as every other inventory-mutating
 * endpoint (purchases, adjustments). `?branchId=`/`?status=` are optional
 * filters, same branch-scoping rule as suppliers/due-report's own route: a
 * branch-restricted caller's own grant always wins over the query param.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const url = new URL(request.url);
    const branchIdParam = url.searchParams.get("branchId");
    const statusParam = url.searchParams.get("status");
    const status: StatusFilter | undefined = STATUS_VALUES.includes(statusParam as StatusFilter)
      ? (statusParam as StatusFilter)
      : undefined;

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, {
        role,
        branchId: grantedBranchId,
      });
      effectiveBranchId = branchIdParam;
    }

    const rows = await listStockCounts(restaurantId, { branchId: effectiveBranchId, status });
    return NextResponse.json({ stockCounts: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const parsed = await parseJsonBody(request, createStockCountSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    // A branch-restricted caller can only start a count for their own
    // branch; an unrestricted caller's chosen branchId is verified before
    // use — same defense-in-depth as every other branch-scoped create.
    await requireBranchAccess(session.user.id, restaurantId, data.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const count = await createStockCount({
      restaurantId,
      branchId: data.branchId,
      countedByUserId: session.user.id,
      notes: data.notes || null,
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_count.created",
      resourceType: "stock_count",
      resourceId: count.id,
      ipAddress: getClientIp(request),
      metadata: { branchId: data.branchId },
    });

    return NextResponse.json({ stockCount: count }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
