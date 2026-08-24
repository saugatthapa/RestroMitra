import { NextResponse } from "next/server";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getSupplierDueReport, type SupplierDueStatusFilter } from "@/lib/supplier-dues";

const STATUS_VALUES: SupplierDueStatusFilter[] = ["all", "overdue", "due_today", "due_this_week"];

/**
 * Supplier Due Report (Section 11-14): total/overdue/due-today/due-this-week
 * outstanding balances plus a per-supplier rollup and the underlying rows,
 * for every credit purchase not yet fully settled or voided. Gated behind
 * MANAGE_INVENTORY — the same trust tier suppliers/purchases already use
 * (see suppliers/route.ts's own comment on why supply-chain data is
 * treated as more sensitive than menu availability).
 *
 * `?branchId=`/`?supplierId=`/`?status=` are all optional filters. Same
 * branch-scoping rule as reports/summary/route.ts: a branch-restricted
 * caller's own grant always wins over the query param; an unrestricted
 * caller's `?branchId=` is verified via requireBranchAccess before use.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const url = new URL(request.url);
    const branchIdParam = url.searchParams.get("branchId");
    const supplierIdParam = url.searchParams.get("supplierId") || undefined;
    const statusParam = url.searchParams.get("status");
    const status: SupplierDueStatusFilter = STATUS_VALUES.includes(statusParam as SupplierDueStatusFilter)
      ? (statusParam as SupplierDueStatusFilter)
      : "all";

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

    const report = await getSupplierDueReport(restaurantId, timezone, {
      branchId: effectiveBranchId,
      supplierId: supplierIdParam,
      status,
    });

    return NextResponse.json(report);
  } catch (err) {
    return toErrorResponse(err);
  }
}
