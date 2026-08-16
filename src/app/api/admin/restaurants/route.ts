import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, userRoles, users } from "@/db/schema";
import { requirePlatformAdmin } from "@/lib/rbac/guard";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { SUBSCRIPTION_STATUSES } from "@/lib/subscription";

const LIST_LIMIT = 200;

/**
 * The platform admin console's restaurant list — every tenant on the
 * platform, not scoped to any one of them (that's the whole point of this
 * route living under /api/admin/ rather than /api/restaurants/[slug]/).
 * `?status=` filters by subscription status; `?q=` searches name/slug.
 */
export async function GET(request: Request) {
  try {
    await requirePlatformAdmin();

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && SUBSCRIPTION_STATUSES.includes(statusParam as (typeof SUBSCRIPTION_STATUSES)[number])
        ? (statusParam as (typeof SUBSCRIPTION_STATUSES)[number])
        : null;
    const q = url.searchParams.get("q")?.trim();

    const rows = await db
      .select({
        id: restaurants.id,
        slug: restaurants.slug,
        name: restaurants.name,
        type: restaurants.type,
        subscriptionStatus: restaurants.subscriptionStatus,
        trialEndsAt: restaurants.trialEndsAt,
        planKey: restaurants.planKey,
        isActive: restaurants.isActive,
        createdAt: restaurants.createdAt,
      })
      .from(restaurants)
      .where(
        and(
          status ? eq(restaurants.subscriptionStatus, status) : undefined,
          q ? or(ilike(restaurants.name, `%${q}%`), ilike(restaurants.slug, `%${q}%`)) : undefined,
        ),
      )
      .orderBy(desc(restaurants.createdAt))
      .limit(LIST_LIMIT);

    // One extra query for owner contact info, rather than an N+1 per row —
    // scoped to exactly the restaurant ids just fetched (never unbounded),
    // so this stays cheap regardless of total platform size.
    const restaurantIds = rows.map((r) => r.id);
    const owners =
      restaurantIds.length > 0
        ? await db
            .select({
              restaurantId: userRoles.restaurantId,
              fullName: users.fullName,
              phone: users.phone,
            })
            .from(userRoles)
            .innerJoin(users, eq(userRoles.userId, users.id))
            .where(
              and(
                eq(userRoles.role, "owner"),
                inArray(userRoles.restaurantId, restaurantIds),
              ),
            )
        : [];
    const ownerByRestaurant = new Map(owners.map((o) => [o.restaurantId, o]));

    return NextResponse.json({
      restaurants: rows.map((r) => ({
        ...r,
        owner: ownerByRestaurant.get(r.id) ?? null,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
