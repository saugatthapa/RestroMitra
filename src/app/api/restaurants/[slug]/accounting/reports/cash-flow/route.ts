import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getCashFlowStatement } from "@/lib/accounting/cash-flow";
import { reportDateSchema } from "@/lib/validation/accounting";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 5, Slice 5c — Cash Flow Statement for a period. Unlike the other
 * reports (Trial Balance/P&L/Balance Sheet), both `fromDate` and `toDate`
 * are always required by getCashFlowStatement itself (a beginning/ending
 * cash position needs a defined period) — defaulted here to the current
 * calendar month if the query params are missing or invalid, same "sensible
 * default, not an error" convention the rest of this module's reports use.
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
      timezone,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const fromDateParam = url.searchParams.get("fromDate");
    const toDateParam = url.searchParams.get("toDate");
    const parsedFrom = fromDateParam ? reportDateSchema.safeParse(fromDateParam) : undefined;
    const parsedTo = toDateParam ? reportDateSchema.safeParse(toDateParam) : undefined;
    const branchIdParam = url.searchParams.get("branchId");

    const toDate = parsedTo?.success ? parsedTo.data : restaurantDate(timezone);
    const fromDate = parsedFrom?.success ? parsedFrom.data : `${toDate.slice(0, 7)}-01`;

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, { role, branchId: grantedBranchId });
      effectiveBranchId = branchIdParam;
    }

    const statement = await getCashFlowStatement({ restaurantId, fromDate, toDate, branchId: effectiveBranchId });

    return NextResponse.json(statement);
  } catch (err) {
    return toErrorResponse(err);
  }
}
