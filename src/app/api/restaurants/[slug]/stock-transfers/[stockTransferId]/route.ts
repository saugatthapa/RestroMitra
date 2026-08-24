import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireEitherBranchAccess } from "@/lib/rbac/guard";
import { getStockTransferDetail } from "@/lib/stock-transfer";

/** One transfer's header plus its line items. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; stockTransferId: string }> },
) {
  try {
    const { slug, stockTransferId } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const detail = await getStockTransferDetail(restaurantId, stockTransferId);
    await requireEitherBranchAccess(session.user.id, restaurantId, detail.transfer.fromBranchId, detail.transfer.toBranchId, {
      role,
      branchId: grantedBranchId,
    });

    return NextResponse.json(detail);
  } catch (err) {
    return toErrorResponse(err);
  }
}
