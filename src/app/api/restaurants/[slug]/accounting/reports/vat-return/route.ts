import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getVatReturnStatement } from "@/lib/accounting/vat-return";
import { reportDateSchema } from "@/lib/validation/accounting";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 6, Slice 6c — VAT return / tax summary for a period. Same
 * "always-required period, default to the current calendar month" pattern
 * as the Cash Flow Statement route (Slice 5c) — a VAT return is
 * meaningless without a defined period.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const fromDateParam = url.searchParams.get("fromDate");
    const toDateParam = url.searchParams.get("toDate");
    const parsedFrom = fromDateParam ? reportDateSchema.safeParse(fromDateParam) : undefined;
    const parsedTo = toDateParam ? reportDateSchema.safeParse(toDateParam) : undefined;

    const toDate = parsedTo?.success ? parsedTo.data : restaurantDate(timezone);
    const fromDate = parsedFrom?.success ? parsedFrom.data : `${toDate.slice(0, 7)}-01`;

    const statement = await getVatReturnStatement({ restaurantId, fromDate, toDate });

    return NextResponse.json(statement);
  } catch (err) {
    return toErrorResponse(err);
  }
}
