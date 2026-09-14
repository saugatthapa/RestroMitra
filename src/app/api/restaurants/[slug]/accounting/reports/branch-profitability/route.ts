import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getBranchProfitability } from "@/lib/accounting/financial-statements";
import { reportDateSchema } from "@/lib/validation/accounting";

/**
 * Phase 7, Slice 7b — Profit & Loss broken out side by side, one column per
 * branch, for a period (both `fromDate`/`toDate` optional — omit both for
 * "since inception", same convention `getProfitAndLoss` already uses).
 *
 * Unlike this module's other reports, there's no `?branchId=` narrowing
 * query param here — the whole point of this report is comparing branches
 * side by side, so a caller whose own role grant is locked to one branch
 * (`resolveRestaurantContext`'s `branchId`) simply gets that one branch's
 * own column rather than being able to request a narrower view of a report
 * that's already single-branch for them.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNTING,
    );

    const url = new URL(request.url);
    const fromDateParam = url.searchParams.get("fromDate");
    const toDateParam = url.searchParams.get("toDate");
    const parsedFrom = fromDateParam ? reportDateSchema.safeParse(fromDateParam) : undefined;
    const parsedTo = toDateParam ? reportDateSchema.safeParse(toDateParam) : undefined;

    const report = await getBranchProfitability({
      restaurantId,
      fromDate: parsedFrom?.success ? parsedFrom.data : undefined,
      toDate: parsedTo?.success ? parsedTo.data : undefined,
      restrictToBranchIds: grantedBranchId ? [grantedBranchId] : undefined,
    });

    return NextResponse.json(report);
  } catch (err) {
    return toErrorResponse(err);
  }
}
