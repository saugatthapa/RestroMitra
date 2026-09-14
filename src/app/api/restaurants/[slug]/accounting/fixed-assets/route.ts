import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createFixedAssetSchema } from "@/lib/validation/accounting";
import { listFixedAssets, recordFixedAssetAcquisition, resolveMainBranchId } from "@/lib/accounting/fixed-assets";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Phase 5, Slice 5d — Fixed Assets. GET lists every asset this restaurant
 * has recorded (active and disposed alike); POST records a new one and
 * posts its acquisition voucher in the same transaction (see
 * recordFixedAssetAcquisition's own doc comment).
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const fixedAssets = await db.transaction((tx) => listFixedAssets(tx, restaurantId));
    return NextResponse.json({ fixedAssets });
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
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, createFixedAssetSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      const branchId = await resolveMainBranchId(tx, restaurantId);
      return recordFixedAssetAcquisition(tx, {
        restaurantId,
        branchId,
        name: data.name,
        category: data.category || null,
        acquisitionDate: data.acquisitionDate,
        costInPaisa: data.cost,
        usefulLifeMonths: data.usefulLifeMonths,
        salvageValueInPaisa: data.salvageValue,
        fundingMethod: data.fundingMethod,
        bankAccountId: data.bankAccountId || null,
        notes: data.notes || null,
        createdByUserId: session.user.id,
      });
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.fixed_asset_acquired",
      resourceType: "fixed_asset",
      resourceId: result.fixedAsset.id,
      ipAddress: getClientIp(request),
      metadata: { name: result.fixedAsset.name, code: result.fixedAsset.code, costInPaisa: data.cost },
    });

    return NextResponse.json({ fixedAsset: result.fixedAsset, voucher: result.voucher }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
