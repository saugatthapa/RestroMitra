import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getProfitAndLoss } from "@/lib/accounting/financial-statements";
import { reportDateSchema } from "@/lib/validation/accounting";

/**
 * Phase 3 — Profit & Loss for a period (`fromDate`/`toDate`, both optional
 * and independent — omit both for "since inception"). Cash Flow is NOT part
 * of this phase; see ACCOUNTING_MODULE_PLAN.md's review correction #5.
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
    const fromDateParam = url.searchParams.get("fromDate");
    const toDateParam = url.searchParams.get("toDate");
    const parsedFrom = fromDateParam ? reportDateSchema.safeParse(fromDateParam) : undefined;
    const parsedTo = toDateParam ? reportDateSchema.safeParse(toDateParam) : undefined;
    const branchIdParam = url.searchParams.get("branchId");

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, { role, branchId: grantedBranchId });
      effectiveBranchId = branchIdParam;
    }

    const pnl = await getProfitAndLoss({
      restaurantId,
      fromDate: parsedFrom?.success ? parsedFrom.data : undefined,
      toDate: parsedTo?.success ? parsedTo.data : undefined,
      branchId: effectiveBranchId,
    });

    return NextResponse.json(pnl);
  } catch (err) {
    return toErrorResponse(err);
  }
}
