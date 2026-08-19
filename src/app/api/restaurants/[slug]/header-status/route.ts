import { NextResponse } from "next/server";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { orders, inventoryItems, reservations } from "@/db/schema";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { isLowStock } from "@/lib/inventory";

/**
 * Powers the dashboard header's live pills and notification bell
 * (DashboardShell) — polled client-side every few seconds, same cadence as
 * the Orders board's own polling, so the header stays live without a full
 * page reload.
 *
 * - `activeOrders`/`kitchenBusy`: the "N active" / Kitchen Clear|Busy pills
 *   (orders currently somewhere between placed and completed; "busy" means
 *   at least one is actually in "preparing" right now).
 * - `lowStockCount`/`pendingReservationsCount`: what the notification bell
 *   surfaces — real "needs attention" counts, not a decorative static
 *   badge. Reuses the exact `isLowStock()` helper the Inventory page uses
 *   so the two can never disagree on what "low" means, and counts
 *   reservations still in "requested" status the same way the
 *   Reservations board treats them (awaiting staff confirmation).
 * - `pendingOrderIds`: every order still in "pending" (placed, not yet
 *   confirmed by staff) — the source of truth DashboardShell reconciles its
 *   looping new-order alert against every poll, so a tab opened *after* an
 *   order already came in (no order.created SSE event to have caught) still
 *   picks up the alarm instead of staying silent until the next order.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const [orderRows, inventoryRows, pendingReservationsRow] = await Promise.all([
      db
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(
          and(
            eq(orders.restaurantId, restaurantId),
            notInArray(orders.status, ["completed", "cancelled"]),
          ),
        ),
      db
        .select({
          currentStockMilliunits: inventoryItems.currentStockMilliunits,
          reorderLevelMilliunits: inventoryItems.reorderLevelMilliunits,
        })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.restaurantId, restaurantId), eq(inventoryItems.isActive, true))),
      db
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(eq(reservations.restaurantId, restaurantId), eq(reservations.status, "requested"))),
    ]);

    const activeOrders = orderRows.length;
    const kitchenBusy = orderRows.some((row) => row.status === "preparing");
    const lowStockCount = inventoryRows.filter(isLowStock).length;
    const pendingReservationsCount = pendingReservationsRow.length;
    const pendingOrderIds = orderRows.filter((row) => row.status === "pending").map((row) => row.id);

    return NextResponse.json({
      activeOrders,
      kitchenBusy,
      lowStockCount,
      pendingReservationsCount,
      pendingOrderIds,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
