import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { createEventStream, fetchEventsForRestaurant, getLatestEventId, SSE_RESPONSE_HEADERS } from "@/lib/realtime";

/**
 * The staff-facing real-time stream — everything DashboardShell's global
 * listener, OrdersBoard, and KDSBoard subscribe to: new orders, order
 * status changes, and service calls, all multiplexed onto one connection
 * per open dashboard tab rather than one per feature (so three boards open
 * in three tabs doesn't mean three separate SSE connections against the
 * same restaurant). See src/lib/realtime.ts's top-of-file comment for why
 * this is DB-polling under an SSE response rather than a live pub/sub
 * channel — that's a deliberate, honest choice given this app's serverless
 * deployment, not an oversight.
 *
 * No specific permission required beyond an active role grant on this
 * restaurant (same bar as the header-status poll) — a kitchen_staff member
 * with no VIEW_SERVICE_CALLS grant still needs order/KDS events off this
 * same stream; branch scoping (not permission scoping) is what narrows what
 * they receive, via fetchEventsForRestaurant's callerBranchId filter.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, branchId } = await resolveRestaurantContext(slug);

    const lastEventIdHeader = request.headers.get("last-event-id");
    const initialCursor = lastEventIdHeader
      ? Number.parseInt(lastEventIdHeader, 10) || 0
      : await getLatestEventId(restaurantId);

    const stream = createEventStream({
      fetchEvents: fetchEventsForRestaurant(restaurantId, branchId),
      initialCursor,
    });

    return new Response(stream, { headers: SSE_RESPONSE_HEADERS });
  } catch (err) {
    return toErrorResponse(err);
  }
}
