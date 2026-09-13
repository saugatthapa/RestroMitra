import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getAccountsReceivableAging } from "@/lib/accounting/aging";
import { reportDateSchema } from "@/lib/validation/accounting";

/**
 * Phase 5, Slice 5a — the AR mirror of the ap-aging route, against
 * Accounts Receivable / customers.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const asOfDateParam = url.searchParams.get("asOfDate");
    const parsed = asOfDateParam ? reportDateSchema.safeParse(asOfDateParam) : undefined;

    const report = await getAccountsReceivableAging(restaurantId, timezone, parsed?.success ? parsed.data : undefined);

    return NextResponse.json({ report });
  } catch (err) {
    return toErrorResponse(err);
  }
}
