import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { listFixedAssets, listDepreciationEntries } from "@/lib/accounting/fixed-assets";
import { AccountingError } from "@/lib/accounting/post-voucher";

/** One fixed asset's own detail, plus its full depreciation history. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; fixedAssetId: string }> },
) {
  try {
    const { slug, fixedAssetId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const [fixedAsset, depreciationEntries] = await db.transaction(async (tx) => {
      const all = await listFixedAssets(tx, restaurantId);
      const match = all.find((a) => a.id === fixedAssetId);
      if (!match) throw new AccountingError("Fixed asset not found.", 404);
      const entries = await listDepreciationEntries(tx, { restaurantId, fixedAssetId });
      return [match, entries] as const;
    });

    return NextResponse.json({ fixedAsset, depreciationEntries });
  } catch (err) {
    return toErrorResponse(err);
  }
}
