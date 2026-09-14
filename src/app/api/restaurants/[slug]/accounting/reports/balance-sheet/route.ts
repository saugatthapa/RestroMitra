import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getBalanceSheet } from "@/lib/accounting/financial-statements";
import { reportDateSchema } from "@/lib/validation/accounting";

/**
 * Phase 3 — Balance Sheet as of a date (or since inception if `asOfDate` is
 * omitted). Includes a computed "Current Period Earnings" equity line since
 * there are no period-closing entries yet — see getBalanceSheet's own
 * comment and ACCOUNTING_PHASE_3_REPORT.md for why that keeps this
 * arithmetically balanced without yet claiming full financial-picture
 * completeness (that's Phase 4/5).
 *
 * Phase 7, Slice 7b — `?branchId=` optionally scopes to one branch; see
 * trial-balance/route.ts's own comment for the shared security pattern.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const asOfDateParam = url.searchParams.get("asOfDate");
    const parsed = asOfDateParam ? reportDateSchema.safeParse(asOfDateParam) : undefined;
    const branchIdParam = url.searchParams.get("branchId");

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, { role, branchId: grantedBranchId });
      effectiveBranchId = branchIdParam;
    }

    const balanceSheet = await getBalanceSheet({
      restaurantId,
      asOfDate: parsed?.success ? parsed.data : undefined,
      branchId: effectiveBranchId,
    });

    return NextResponse.json(balanceSheet);
  } catch (err) {
    return toErrorResponse(err);
  }
}
