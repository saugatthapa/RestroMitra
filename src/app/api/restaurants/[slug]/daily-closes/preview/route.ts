import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { branches } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getMainBranch } from "@/lib/restaurant";
import { restaurantDate } from "@/lib/restaurant-date";
import { getDailyClosingPreview, isBusinessDateClosed } from "@/lib/daily-closing";

/**
 * Live, uncommitted preview of what closing `?date=` (default: today, in
 * the restaurant's own timezone) would freeze — nothing is written. The
 * Daily Closing screen calls this to show the numbers before the user
 * confirms closing the day.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, timezone, branchId: grantedBranchId } =
      await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_DAILY_CLOSING);

    const url = new URL(request.url);
    const businessDate = url.searchParams.get("date") || restaurantDate(timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      return NextResponse.json({ error: "Invalid date." }, { status: 400 });
    }

    let branchId = url.searchParams.get("branchId") || grantedBranchId;
    if (!branchId) {
      const main = await getMainBranch(restaurantId);
      if (!main) {
        return NextResponse.json({ error: "This restaurant has no branch set up yet." }, { status: 400 });
      }
      branchId = main.id;
    } else {
      const owned = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)))
        .limit(1);
      if (owned.length === 0) {
        return NextResponse.json({ error: "Branch not found." }, { status: 404 });
      }
    }
    await requireBranchAccess(session.user.id, restaurantId, branchId, {
      role,
      branchId: grantedBranchId,
    });

    const [snapshot, alreadyClosed] = await Promise.all([
      getDailyClosingPreview(restaurantId, branchId, businessDate, timezone),
      isBusinessDateClosed(restaurantId, branchId, businessDate),
    ]);

    return NextResponse.json({ snapshot, alreadyClosed });
  } catch (err) {
    return toErrorResponse(err);
  }
}
