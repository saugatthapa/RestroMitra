import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getStockCountDetail } from "@/lib/stock-count";

/** One count's header plus its line items, each with variance/varianceValue/isLarge computed server-side. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; stockCountId: string }> },
) {
  try {
    const { slug, stockCountId } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const detail = await getStockCountDetail(restaurantId, stockCountId);
    await requireBranchAccess(session.user.id, restaurantId, detail.stockCount.branchId, {
      role,
      branchId: grantedBranchId,
    });

    return NextResponse.json(detail);
  } catch (err) {
    return toErrorResponse(err);
  }
}
