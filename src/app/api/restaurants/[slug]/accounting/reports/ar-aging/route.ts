import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getAccountsReceivableAging } from "@/lib/accounting/aging";
import { reportDateSchema } from "@/lib/validation/accounting";

/**
 * Phase 5, Slice 5a — the AR mirror of the ap-aging route, against
 * Accounts Receivable / customers.
 *
 * Phase 7, Slice 7b — `?branchId=` optionally scopes to one branch; see
 * trial-balance/route.ts's own comment for the shared security pattern, and
 * aging.ts's own comment on `computeAging` for why a branch-filtered aging
 * report is a genuinely different (narrower, documented) view than the
 * unfiltered one, not just the same numbers split up.
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

    const report = await getAccountsReceivableAging(
      restaurantId,
      timezone,
      parsed?.success ? parsed.data : undefined,
      effectiveBranchId,
    );

    return NextResponse.json({ report });
  } catch (err) {
    return toErrorResponse(err);
  }
}
