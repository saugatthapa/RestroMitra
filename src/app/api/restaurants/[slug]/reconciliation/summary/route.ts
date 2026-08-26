import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { reconciliationQuerySchema } from "@/lib/validation/payments";
import { getReconciliationSummary } from "@/lib/financial-reconciliation";

/** Per-method reconciled/unreconciled totals — see reconciliation/route.ts's own doc comment for the shared scoping rules. */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
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

    const summary = await getReconciliationSummary(
      restaurantId,
      {
        branchId: effectiveBranchId,
        from: parsed.data.from,
        to: parsed.data.to,
      },
      timezone,
    );

    return NextResponse.json({ summary });
  } catch (err) {
    return toErrorResponse(err);
  }
}
