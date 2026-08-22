import { NextResponse } from "next/server";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getReportSummary } from "@/lib/reports";
import { restaurantDate } from "@/lib/restaurant-date";

const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysAgoIso(timezone: string, days: number) {
  return restaurantDate(timezone, new Date(Date.now() - days * 86_400_000));
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
 *
 * `?branchId=` optionally scopes every figure to one branch (the header's
 * branch switcher — see BranchProvider/DashboardShell) instead of the
 * whole restaurant. Two things keep this from ever leaking data across
 * branches a caller shouldn't see:
 *   - A staff member whose own role grant is locked to one branch
 *     (`resolveRestaurantContext`'s `branchId`, null = unrestricted) has
 *     that branch forced regardless of what `?branchId=` asks for — the
 *     query param can only ever narrow further, never escape the grant.
 *   - An unrestricted caller's requested `?branchId=` is still verified
 *     via `requireBranchAccess` (belongs to this restaurant, is active)
 *     before use — a client can never simply assert a branch id and get
 *     its data back unchecked.
 * A malformed/unrecognized `?branchId=` value is a real error (400/403
 * via requireBranchAccess), unlike the from/to lenient-fallback above —
 * silently falling back to "all branches" would show MORE data than
 * requested rather than less, the wrong direction to fail open in.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
    } = await resolveRestaurantContext(slug, PERMISSIONS.VIEW_REPORTS);

    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const branchIdParam = url.searchParams.get("branchId");

    let from = fromParam && DATE_RE.test(fromParam) ? fromParam : daysAgoIso(timezone, DEFAULT_RANGE_DAYS - 1);
    let to = toParam && DATE_RE.test(toParam) ? toParam : restaurantDate(timezone);

    // Span check stays in plain UTC-midnight arithmetic on the date
    // STRINGS themselves (not an actual restaurant-local instant) — this
    // is only measuring "how many calendar days apart are these two
    // labels," which is timezone-independent by construction as long as
    // both ends are read the same way.
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

    const summary = await getReportSummary(restaurantId, { from, to }, timezone, effectiveBranchId);

    return NextResponse.json(summary);
  } catch (err) {
    return toErrorResponse(err);
  }
}
