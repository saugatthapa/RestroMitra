import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getTaxDepreciationReport, currentIncomeYear } from "@/lib/accounting/tax-depreciation";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 6, Slice 6e — Nepal tax depreciation (pooled declining-balance), a
 * read-only report alongside Slice 6c's VAT Return. `?incomeYear=2082`
 * (a BS year — the year its own Shrawan 1 falls in) selects which income
 * year to compute through; defaults to the restaurant's own current one.
 * See tax-depreciation.ts's own top-of-file comment for the mechanics and,
 * importantly, this report's verification status before trusting a figure
 * it produces.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const incomeYearParam = url.searchParams.get("incomeYear");
    const parsedYear = incomeYearParam ? Number(incomeYearParam) : NaN;
    const throughIncomeYear =
      Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2200
        ? parsedYear
        : currentIncomeYear(new Date(`${restaurantDate(timezone)}T00:00:00`));

    const report = await db.transaction((tx) => getTaxDepreciationReport(tx, { restaurantId, throughIncomeYear }));

    return NextResponse.json(report);
  } catch (err) {
    return toErrorResponse(err);
  }
}
