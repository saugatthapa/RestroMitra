import { NextResponse } from "next/server";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { computeBillingSummary } from "@/lib/payments";
import { db } from "@/db";

/**
 * Full detail for a single order — items, addons, table, and the payment
 * ledger — used by the dashboard bill/payment view (Task 39) and the POS
 * "existing order" lookup. Any staff member with restaurant access can
 * view (same read/write split as the order list); only payment/refund
 * actions are permission-gated, in their own route files.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/orders/[orderId]">,
) {
  try {
    const { slug, orderId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const order = await db.query.orders.findFirst({
      where: (o, { and, eq }) => and(eq(o.id, orderId), eq(o.restaurantId, restaurantId)),
      with: {
        table: { columns: { id: true, name: true } },
        customer: { columns: { id: true, fullName: true, phone: true, loyaltyPointsBalance: true } },
        items: { with: { addons: true } },
        payments: {
          orderBy: (p, { asc }) => [asc(p.createdAt)],
        },
      },
    });

    if (!order) {
      return NextResponse.json({ error: "Order not found." }, { status: 404 });
    }

    const billing = computeBillingSummary(
      order.totalInPaisa,
      order.payments.map((p) => p.amountInPaisa),
      order.payments.map((p) => p.tipInPaisa),
    );

    return NextResponse.json({ order, billing });
  } catch (err) {
    return toErrorResponse(err);
  }
}
