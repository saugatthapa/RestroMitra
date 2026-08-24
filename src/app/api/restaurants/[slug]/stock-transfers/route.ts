import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess, requireEitherBranchAccess } from "@/lib/rbac/guard";
import { createStockTransferSchema } from "@/lib/validation/inventory";
import { createStockTransfer, listStockTransfers } from "@/lib/stock-transfer";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const STATUS_VALUES = ["requested", "approved", "dispatched", "received", "cancelled"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

/**
 * Stock Transfer (Commercial Launch Phase A.7) — branch-to-branch stock
 * moves. Gated behind MANAGE_INVENTORY throughout (same tier as every
 * other inventory-mutating endpoint); a branch-restricted caller needs
 * access to at least one of the two branches involved — see
 * requireEitherBranchAccess's own comment in guard.ts. `?branchId=`
 * matches transfers either FROM or TO that branch; `?status=` filters the
 * lifecycle stage.
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

    // A branch-restricted caller is always scoped to their own branch
    // regardless of the query param — same rule as every other branch-
    // scoped listing route. An unrestricted caller's explicit `?branchId=`
    // is verified before use.
    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, { role, branchId: grantedBranchId });
      effectiveBranchId = branchIdParam;
    }

    const rows = await listStockTransfers(restaurantId, { branchId: effectiveBranchId, status });
    return NextResponse.json({ stockTransfers: rows });
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

    const parsed = await parseJsonBody(request, createStockTransferSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    await requireEitherBranchAccess(session.user.id, restaurantId, data.fromBranchId, data.toBranchId, {
      role,
      branchId: grantedBranchId,
    });

    const result = await createStockTransfer({
      restaurantId,
      fromBranchId: data.fromBranchId,
      toBranchId: data.toBranchId,
      requestedByUserId: session.user.id,
      notes: data.notes || null,
      items: data.items.map((i) => ({ inventoryItemId: i.inventoryItemId, quantityMilliunits: i.quantity })),
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.stock_transfer.requested",
      resourceType: "stock_transfer",
      resourceId: result.transfer.id,
      ipAddress: getClientIp(request),
      metadata: { fromBranchId: data.fromBranchId, toBranchId: data.toBranchId, lineCount: result.items.length },
    });

    return NextResponse.json({ transfer: result.transfer, items: result.items }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
