import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getTrialBalance } from "@/lib/accounting/financial-statements";
import { reportDateSchema } from "@/lib/validation/accounting";

/**
 * Phase 3 — Trial Balance as of a date (or since inception if `asOfDate` is
 * omitted). Column totals should always match by construction (postVoucher
 * refuses anything that doesn't balance) — `isBalanced` is reported anyway
 * so the UI can flag it plainly if that ever turns out false.
 *
 * Phase 7, Slice 7b — `?branchId=` optionally scopes to one branch, same
 * security pattern as `/api/restaurants/[slug]/reports/summary`'s own
 * `?branchId=`: a caller whose own role grant is locked to one branch
 * (`resolveRestaurantContext`'s `branchId`) has that branch forced
 * regardless of the query param; an unrestricted caller's requested branch
 * is verified via `requireBranchAccess` before use.
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

    const trialBalance = await getTrialBalance({
      restaurantId,
      asOfDate: parsed?.success ? parsed.data : undefined,
      branchId: effectiveBranchId,
    });

    return NextResponse.json(trialBalance);
  } catch (err) {
    return toErrorResponse(err);
  }
}
