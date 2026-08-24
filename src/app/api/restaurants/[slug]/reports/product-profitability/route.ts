import { NextResponse } from "next/server";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getProductProfitability } from "@/lib/reports";
import { restaurantDate } from "@/lib/restaurant-date";

const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysAgoIso(timezone: string, days: number) {
  return restaurantDate(timezone, new Date(Date.now() - days * 86_400_000));
}

/**
 * Product-Level Profitability (Section 23): per menu item revenue, COGS,
 * gross profit, and margin %, most-revenue-first. Gated behind VIEW_PROFIT
 * specifically, NOT VIEW_REPORTS — unlike reports/summary (which bundles
 * cost/margin figures into a payload otherwise gated only behind
 * VIEW_REPORTS, relying on the dashboard UI to hide them from a
 * non-profit-viewing role), this endpoint's entire payload IS cost/margin
 * data, so there's no reason to ever send it to a caller who can't see
 * profit at all.
 *
 * `?from=`/`?to=`/`?branchId=` follow the exact same contract as
 * reports/summary/route.ts — see that route's own comment for the
 * lenient-date-fallback vs. strict-branchId-verification reasoning.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
    } = await resolveRestaurantContext(slug, PERMISSIONS.VIEW_PROFIT);

    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const branchIdParam = url.searchParams.get("branchId");

    let from = fromParam && DATE_RE.test(fromParam) ? fromParam : daysAgoIso(timezone, DEFAULT_RANGE_DAYS - 1);
    let to = toParam && DATE_RE.test(toParam) ? toParam : restaurantDate(timezone);

    const spanDays = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000;
    if (Number.isNaN(spanDays) || spanDays < 0 || spanDays > MAX_RANGE_DAYS) {
      from = daysAgoIso(timezone, DEFAULT_RANGE_DAYS - 1);
      to = restaurantDate(timezone);
    }

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, {
        role,
        branchId: grantedBranchId,
      });
      effectiveBranchId = branchIdParam;
    }

    const products = await getProductProfitability(restaurantId, { from, to }, timezone, effectiveBranchId);

    return NextResponse.json({ products, from, to });
  } catch (err) {
    return toErrorResponse(err);
  }
}
