import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, subscriptionEvents } from "@/db/schema";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { computeSubscriptionAccess } from "@/lib/subscription";
import { getPlanByKey } from "@/lib/plans";

const EVENT_HISTORY_LIMIT = 20;

/**
 * A restaurant's own billing status — status, trial countdown, current
 * plan, and recent subscription history. Open to any active staff member
 * (same "reads are open, writes are gated" pattern as menu/order GETs),
 * not just MANAGE_SUBSCRIPTION holders: everyone should be able to see
 * *why* they were redirected to /billing, even though only an owner can
 * act on it (see the upgrade-request route, and the dashboard-side
 * `canManageSubscription` prop this powers).
 *
 * Explicitly allows inactive-subscription access — this is the one route
 * a blocked restaurant's own dashboard redirect (see
 * src/app/dashboard/layout.tsx) sends people to, so it can never itself
 * be blocked by the same check.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/billing">,
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, role } = await resolveRestaurantContext(slug, undefined, {
      allowInactiveSubscription: true,
    });

    const [restaurant] = await db
      .select({
        subscriptionStatus: restaurants.subscriptionStatus,
        trialEndsAt: restaurants.trialEndsAt,
        planKey: restaurants.planKey,
      })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    if (!restaurant) {
      return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
    }

    const events = await db
      .select({
        id: subscriptionEvents.id,
        eventType: subscriptionEvents.eventType,
        fromStatus: subscriptionEvents.fromStatus,
        toStatus: subscriptionEvents.toStatus,
        planKey: subscriptionEvents.planKey,
        note: subscriptionEvents.note,
        createdAt: subscriptionEvents.createdAt,
      })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.restaurantId, restaurantId))
      .orderBy(desc(subscriptionEvents.createdAt))
      .limit(EVENT_HISTORY_LIMIT);

    return NextResponse.json({
      subscriptionStatus: restaurant.subscriptionStatus,
      trialEndsAt: restaurant.trialEndsAt,
      planKey: restaurant.planKey,
      plan: getPlanByKey(restaurant.planKey),
      access: computeSubscriptionAccess(restaurant),
      canManageSubscription: role === "owner" || role === "platform_admin",
      events,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
