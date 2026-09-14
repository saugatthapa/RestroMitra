import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { listFixedAssets, listDepreciationEntries, setFixedAssetTaxDepreciationPool } from "@/lib/accounting/fixed-assets";
import { AccountingError } from "@/lib/accounting/post-voucher";
import { setFixedAssetTaxDepreciationPoolSchema } from "@/lib/validation/accounting";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

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

/**
 * Phase 6, Slice 6e — the ONLY thing this route lets an owner change about
 * an existing fixed asset: which Nepal tax-depreciation pool (A-E) it
 * belongs to, or clearing that classification (`taxDepreciationPool: null`).
 * See setFixedAssetTaxDepreciationPool's own comment — no Slice 5d
 * book-depreciation field is editable through this route.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; fixedAssetId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, fixedAssetId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, setFixedAssetTaxDepreciationPoolSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const fixedAsset = await db.transaction((tx) =>
      setFixedAssetTaxDepreciationPool(tx, {
        restaurantId,
        fixedAssetId,
        taxDepreciationPool: data.taxDepreciationPool,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.fixed_asset_tax_pool_set",
      resourceType: "fixed_asset",
      resourceId: fixedAssetId,
      ipAddress: getClientIp(request),
      metadata: { taxDepreciationPool: data.taxDepreciationPool },
    });

    return NextResponse.json({ fixedAsset });
  } catch (err) {
    return toErrorResponse(err);
  }
}
