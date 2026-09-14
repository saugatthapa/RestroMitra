import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getInventoryValuationReport } from "@/lib/accounting/inventory-valuation";
import { reportDateSchema } from "@/lib/validation/accounting";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 7, Slice 7d — Inventory Valuation. `fromDate`/`toDate` default to
 * the current calendar month, same convention every other period report in
 * this module uses. Returns `report: null` (not an error) when this
 * restaurant has no Inventory account mapped yet — same "viewable before
 * accounting is fully set up" posture as every other Phase 5/6/7 report.
 *
 * Deliberately not branch-scoped: per `inventory-valuation.ts`'s own
 * top-of-file comment, this report values inventory as the ledger's own
 * Inventory account balance, and (per schema.ts's Phase 1 design comment)
 * `chart_of_accounts` itself is not split per branch — only the vouchers
 * that move it are. A branch breakdown of inventory movement would need a
 * different query than `getCashBookReport` provides; out of scope for this
 * slice, same as Slice 7a's own Cash Book (single account, not branch-aware).
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

    const report = await getInventoryValuationReport({ restaurantId, fromDate, toDate });

    return NextResponse.json({ report });
  } catch (err) {
    return toErrorResponse(err);
  }
}
