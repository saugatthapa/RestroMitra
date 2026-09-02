import { NextResponse } from "next/server";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, userRoles, users, subscriptionEvents } from "@/db/schema";
import { requirePlatformPermission, getActivePlatformRoles } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS, roleHasPlatformPermission } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getEffectivePlan, getAllPlansForAdmin, aiMonthlyRequestLimitForRestaurant } from "@/lib/plans-db";
import { countAiRequestsThisMonth } from "@/lib/ai/usage-db";
import { listSupportNotes } from "@/lib/support/notes-db";
import { listSupportTags } from "@/lib/support/tags-db";
import { getRestaurantHealthScore } from "@/lib/support/health-score-db";
import { rateLimit } from "@/lib/rate-limit";

const EVENT_HISTORY_LIMIT = 50;

// Phase 2 — gated on VIEW_TENANTS, same reasoning as the list route.
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.VIEW_TENANTS);

    // QA hardening (P2 backlog): platform-admin list/read endpoints had no
    // rate limiting of their own — lower severity since they require an
    // already-authenticated, MFA'd platform-admin session, but still a
    // defense-in-depth backstop. Shares the `admin-read:user` bucket with
    // every other admin list/read route, same "one abuse surface" pattern
    // as menu-write:user.
    const limit = await rateLimit(`admin-read:user:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

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

    // Phase 9 (Support tooling) — the staff list, internal notes, status
    // tags, and health score are all support-team-facing, so they're only
    // included for a caller who actually holds MANAGE_SUPPORT — a
    // platform_viewer (VIEW_TENANTS only, which is all this route
    // otherwise requires) sees the tenant detail page without any of the
    // support-specific panels rather than getting a 403 for the whole
    // route.
    const platformRoles = await getActivePlatformRoles(session.user.id);
    const canManageSupport = platformRoles.some((role) =>
      roleHasPlatformPermission(role, PLATFORM_PERMISSIONS.MANAGE_SUPPORT),
    );

    const [staff, supportNotes, supportTags, healthScore] = canManageSupport
      ? await Promise.all([
          db
            .select({
              userRoleId: userRoles.id,
              userId: userRoles.userId,
              fullName: users.fullName,
              phone: users.phone,
              role: userRoles.role,
              isActive: userRoles.isActive,
            })
            .from(userRoles)
            .innerJoin(users, eq(userRoles.userId, users.id))
            .where(and(eq(userRoles.restaurantId, restaurantId), eq(userRoles.isActive, true))),
          listSupportNotes(restaurantId),
          listSupportTags(restaurantId),
          getRestaurantHealthScore(restaurantId),
        ])
      : [[], [], [], null];

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
      // Phase 9 — null/empty when the caller lacks MANAGE_SUPPORT (see
      // above); the UI treats a null healthScore as "hidden", not "0".
      staff,
      supportNotes,
      supportTags,
      healthScore,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
