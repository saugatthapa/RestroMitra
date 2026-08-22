import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getLedgerDayBook, getLedgerRollup, getOutstandingDues } from "@/lib/ledger-reports";
import { restaurantDate } from "@/lib/restaurant-date";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day-book / month-book / year-book endpoint.
 *
 * `?granularity=day&date=YYYY-MM-DD` -> that day's full entry list + totals.
 * `?granularity=month&date=YYYY-MM-DD` -> one row per day in that month
 *   (any day within the month works as the anchor) + month totals.
 * `?granularity=year&date=YYYY-MM-DD` -> one row per month in that year +
 *   year totals.
 *
 * Always also returns `outstandingDues` — the full "who owes whom" list,
 * unscoped by the requested period (see getOutstandingDues's own comment)
 * — so every book view can show the same running due total without a
 * second round trip.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNT_BOOKS);

    const url = new URL(request.url);
    const granularity = url.searchParams.get("granularity");
    const date = url.searchParams.get("date") ?? restaurantDate(timezone);

    if (!ISO_DATE.test(date)) {
      return NextResponse.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
    }
    if (granularity !== "day" && granularity !== "month" && granularity !== "year") {
      return NextResponse.json(
        { error: "granularity must be one of: day, month, year." },
        { status: 400 },
      );
    }

    const [book, outstandingDues] = await Promise.all([
      granularity === "day"
        ? getLedgerDayBook(restaurantId, date)
        : getLedgerRollup(restaurantId, granularity, date),
      getOutstandingDues(restaurantId),
    ]);

    return NextResponse.json({ granularity, book, outstandingDues });
  } catch (err) {
    return toErrorResponse(err);
  }
}
