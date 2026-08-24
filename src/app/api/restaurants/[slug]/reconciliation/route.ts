import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { reconciliationQuerySchema } from "@/lib/validation/payments";
import { listPaymentsForReconciliation } from "@/lib/financial-reconciliation";

/**
 * Financial Reconciliation (Commercial Launch Phase A.8) — lists
 * card/mobile_wallet/other payments, filterable by branch/method/date range
 * and reconciliation status (defaults to "unreconciled", the working
 * queue). Gated behind MANAGE_ACCOUNT_BOOKS — this is a bookkeeping task,
 * same trust tier as Account Books itself, not a new permission (see
 * financial-reconciliation.ts's module doc comment for why no new
 * permission was introduced).
 *
 * Branch scoping follows the same rule as suppliers/due-report/route.ts: a
 * branch-restricted caller's own grant always wins over `?branchId=`; an
 * unrestricted caller's `?branchId=` is verified via requireBranchAccess
 * before use.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNT_BOOKS);

    const url = new URL(request.url);
    const parsed = reconciliationQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid query parameters." }, { status: 400 });
    }

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (parsed.data.branchId) {
      await requireBranchAccess(session.user.id, restaurantId, parsed.data.branchId, {
        role,
        branchId: grantedBranchId,
      });
      effectiveBranchId = parsed.data.branchId;
    }

    const payments = await listPaymentsForReconciliation(
      restaurantId,
      {
        branchId: effectiveBranchId,
        method: parsed.data.method,
        from: parsed.data.from,
        to: parsed.data.to,
      },
      parsed.data.status ?? "unreconciled",
    );

    return NextResponse.json({ payments });
  } catch (err) {
    return toErrorResponse(err);
  }
}
