import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getProfitAndLoss } from "@/lib/accounting/financial-statements";
import { reportDateSchema } from "@/lib/validation/accounting";

/**
 * Phase 3 — Profit & Loss for a period (`fromDate`/`toDate`, both optional
 * and independent — omit both for "since inception"). Cash Flow is NOT part
 * of this phase; see ACCOUNTING_MODULE_PLAN.md's review correction #5.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const fromDateParam = url.searchParams.get("fromDate");
    const toDateParam = url.searchParams.get("toDate");
    const parsedFrom = fromDateParam ? reportDateSchema.safeParse(fromDateParam) : undefined;
    const parsedTo = toDateParam ? reportDateSchema.safeParse(toDateParam) : undefined;

    const pnl = await getProfitAndLoss({
      restaurantId,
      fromDate: parsedFrom?.success ? parsedFrom.data : undefined,
      toDate: parsedTo?.success ? parsedTo.data : undefined,
    });

    return NextResponse.json(pnl);
  } catch (err) {
    return toErrorResponse(err);
  }
}
