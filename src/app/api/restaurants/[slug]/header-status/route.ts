import { NextResponse } from "next/server";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";

/**
 * Powers the two live status pills in the dashboard header (DashboardShell)
 * — "N active" (orders currently somewhere between placed and completed)
 * and a Kitchen Clear/Busy indicator (anything actually in the "preparing"
 * status right now). Polled client-side every few seconds, same cadence as
 * the Orders board's own polling, so the header stays live without a full
 * page reload — this is the functional gap behind the reference
 * dashboard's "Active 0" / "Kitchen Clear" pills; ours is backed by a real
 * query rather than a static demo value.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/header-status">,
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const rows = await db
      .select({ status: orders.status })
      .from(orders)
      .where(
        and(
          eq(orders.restaurantId, restaurantId),
          notInArray(orders.status, ["completed", "cancelled"]),
        ),
      );

    const activeOrders = rows.length;
    const kitchenBusy = rows.some((row) => row.status === "preparing");

    return NextResponse.json({ activeOrders, kitchenBusy });
  } catch (err) {
    return toErrorResponse(err);
  }
}
