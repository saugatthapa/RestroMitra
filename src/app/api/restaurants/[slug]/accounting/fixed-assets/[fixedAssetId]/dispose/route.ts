import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { disposeFixedAssetSchema } from "@/lib/validation/accounting";
import { disposeFixedAsset, resolveMainBranchId } from "@/lib/accounting/fixed-assets";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Disposes of a fixed asset — see disposeFixedAsset's own doc comment for
 * the full posting shape (proceeds + gain/loss, per sign-off). A gain or
 * loss is never an error; the response's `gainOrLossInPaisa` tells the UI
 * which one this was (positive = gain, negative = loss, zero = neither).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; fixedAssetId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, fixedAssetId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, disposeFixedAssetSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      const branchId = await resolveMainBranchId(tx, restaurantId);
      return disposeFixedAsset(tx, {
        restaurantId,
        branchId,
        fixedAssetId,
        disposalDate: data.disposalDate,
        proceedsInPaisa: data.proceeds,
        proceedsMethod: data.proceedsMethod,
        bankAccountId: data.bankAccountId || null,
        createdByUserId: session.user.id,
      });
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.fixed_asset_disposed",
      resourceType: "fixed_asset",
      resourceId: fixedAssetId,
      ipAddress: getClientIp(request),
      metadata: { gainOrLossInPaisa: result.gainOrLossInPaisa, proceedsInPaisa: data.proceeds },
    });

    return NextResponse.json({ fixedAsset: result.fixedAsset, voucher: result.voucher, gainOrLossInPaisa: result.gainOrLossInPaisa });
  } catch (err) {
    return toErrorResponse(err);
  }
}
