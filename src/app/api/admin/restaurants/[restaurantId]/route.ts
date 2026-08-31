import { NextResponse } from "next/server";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, userRoles, users, subscriptionEvents } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getEffectivePlan, getAllPlansForAdmin, aiMonthlyRequestLimitForRestaurant } from "@/lib/plans-db";
import { countAiRequestsThisMonth } from "@/lib/ai/usage-db";

const EVENT_HISTORY_LIMIT = 50;

// Phase 2 — gated on VIEW_TENANTS, same reasoning as the list route.
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.VIEW_TENANTS);
    const { restaurantId } = await ctx.params;

    const [restaurant] = await db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    if (!restaurant) {
      return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
    }

    const [owner] = await db
      .select({ fullName: users.fullName, phone: users.phone, email: users.email })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(and(eq(userRoles.restaurantId, restaurantId), eq(userRoles.role, "owner")))
      .limit(1);

    const [staffCountRow] = await db
      .select({ n: count() })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.restaurantId, restaurantId),
          eq(userRoles.isActive, true),
        ),
      );

    const events = await db
      .select({
        id: subscriptionEvents.id,
        eventType: subscriptionEvents.eventType,
        fromStatus: subscriptionEvents.fromStatus,
        toStatus: subscriptionEvents.toStatus,
        planKey: subscriptionEvents.planKey,
        note: subscriptionEvents.note,
        createdAt: subscriptionEvents.createdAt,
        performedBy: users.fullName,
      })
      .from(subscriptionEvents)
      .leftJoin(users, eq(subscriptionEvents.performedByUserId, users.id))
      .where(eq(subscriptionEvents.restaurantId, restaurantId))
      .orderBy(desc(subscriptionEvents.createdAt))
      .limit(EVENT_HISTORY_LIMIT);

    // Phase 4 — plan is DB-backed now; `plans` (every plan, including
    // retired ones — an admin assigning a plan should still see a
    // since-retired one this restaurant might already be on) replaces the
    // static PLANS array the detail page used to import client-side for
    // its "Assign plan" dropdown.
    const [plan, allPlans, aiMonthlyRequestLimit, aiRequestsThisMonth] = await Promise.all([
      getEffectivePlan(restaurant),
      getAllPlansForAdmin(),
      aiMonthlyRequestLimitForRestaurant(restaurant),
      countAiRequestsThisMonth(restaurant.id),
    ]);

    return NextResponse.json({
      restaurant: {
        id: restaurant.id,
        slug: restaurant.slug,
        name: restaurant.name,
        type: restaurant.type,
        city: restaurant.city,
        district: restaurant.district,
        subscriptionStatus: restaurant.subscriptionStatus,
        trialEndsAt: restaurant.trialEndsAt,
        planKey: restaurant.planKey,
        plan,
        lockedMonthlyPriceInPaisa: restaurant.lockedMonthlyPriceInPaisa,
        // Phase 7 — the override itself (null = "use the plan's limit")
        // plus the already-resolved effective limit/usage, so the admin UI
        // doesn't need to re-derive the override-then-plan-then-trial
        // precedence client-side.
        aiMonthlyRequestLimitOverride: restaurant.aiMonthlyRequestLimitOverride,
        aiMonthlyRequestLimit,
        aiRequestsThisMonth,
        isActive: restaurant.isActive,
        createdAt: restaurant.createdAt,
      },
      owner: owner ?? null,
      staffCount: staffCountRow?.n ?? 0,
      events,
      plans: allPlans,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
