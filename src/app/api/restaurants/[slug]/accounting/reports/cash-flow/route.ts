import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
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

    const statement = await getCashFlowStatement({ restaurantId, fromDate, toDate });

    return NextResponse.json(statement);
  } catch (err) {
    return toErrorResponse(err);
  }
}
