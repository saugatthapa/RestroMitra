import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getAccountsPayableAging } from "@/lib/accounting/aging";
import { reportDateSchema } from "@/lib/validation/accounting";

/**
 * Phase 5, Slice 5a — Accounts Payable aging as of a date (or today if
 * `asOfDate` is omitted). Returns `{ report: null }` rather than an error
 * for a restaurant with no Accounts Payable account mapped yet — see
 * `getAccountsPayableAging`'s own doc comment.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const asOfDateParam = url.searchParams.get("asOfDate");
    const parsed = asOfDateParam ? reportDateSchema.safeParse(asOfDateParam) : undefined;

    const report = await getAccountsPayableAging(restaurantId, timezone, parsed?.success ? parsed.data : undefined);

    return NextResponse.json({ report });
  } catch (err) {
    return toErrorResponse(err);
  }
}
