import { NextResponse } from "next/server";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getReportSummary } from "@/lib/reports";

const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The single endpoint the Reports dashboard calls — bundles sales
 * summary, the revenue-vs-expenses trend, top items, and the payment/
 * expense breakdowns into one payload (see getReportSummary's own
 * comment for why). Gated behind VIEW_REPORTS, already in the permission
 * catalog since Phase 1 and granted to manager/owner by default — no
 * catalog change needed for this phase.
 *
 * `?from=`/`?to=` (YYYY-MM-DD, inclusive) scope the range; defaults to
 * the trailing 30 days when omitted. A malformed or backwards range
 * (from after to, or exceeding MAX_RANGE_DAYS) falls back to the default
 * rather than erroring — a bad query param shouldn't 400 a dashboard
 * page load, it should just show something sane.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.VIEW_REPORTS);

    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");

    let from = fromParam && DATE_RE.test(fromParam) ? fromParam : daysAgoIso(DEFAULT_RANGE_DAYS - 1);
    let to = toParam && DATE_RE.test(toParam) ? toParam : todayIso();

    const spanDays = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000;
    if (Number.isNaN(spanDays) || spanDays < 0 || spanDays > MAX_RANGE_DAYS) {
      from = daysAgoIso(DEFAULT_RANGE_DAYS - 1);
      to = todayIso();
    }

    const summary = await getReportSummary(restaurantId, { from, to });

    return NextResponse.json(summary);
  } catch (err) {
    return toErrorResponse(err);
  }
}
