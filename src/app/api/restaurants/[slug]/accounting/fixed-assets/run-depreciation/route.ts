import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { runDepreciationSchema } from "@/lib/validation/accounting";
import { runDepreciation, resolveMainBranchId } from "@/lib/accounting/fixed-assets";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * "Run Depreciation for <month>" — a deliberately human-triggered action,
 * never a background cron (see fixed-assets.ts's own top-of-file comment).
 * Safe to call more than once for the same month: an asset already caught
 * up through that date is simply skipped, so a restaurant that runs this
 * twice by mistake (or re-runs after adding a new asset mid-month) posts
 * nothing twice — see runDepreciation's own doc comment.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, runDepreciationSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      const branchId = await resolveMainBranchId(tx, restaurantId);
      return runDepreciation(tx, {
        restaurantId,
        branchId,
        year: data.year,
        month: data.month,
        createdByUserId: session.user.id,
      });
    });

    if (result.voucher) {
      await recordAuditLog({
        restaurantId,
        userId: session.user.id,
        action: "accounting.depreciation_run",
        resourceType: "accounting_voucher",
        resourceId: result.voucher.id,
        ipAddress: getClientIp(request),
        metadata: { year: data.year, month: data.month, totalInPaisa: result.totalInPaisa, assetCount: result.entries.length },
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
