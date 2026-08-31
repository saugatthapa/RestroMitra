import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, userRoles, users } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { SUBSCRIPTION_STATUSES } from "@/lib/subscription";
import { getAllPlansForAdmin } from "@/lib/plans-db";

const LIST_LIMIT = 200;

/**
 * The platform admin console's restaurant list — every tenant on the
 * platform, not scoped to any one of them (that's the whole point of this
 * route living under /api/admin/ rather than /api/restaurants/[slug]/).
 * `?status=` filters by subscription status; `?q=` searches name/slug.
 *
 * Phase 2 — gated on VIEW_TENANTS (not the coarser requirePlatformAdmin)
 * so every platform role, including platform_viewer, can actually use the
 * console's read side.
 */
export async function GET(request: Request) {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.VIEW_TENANTS);

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && SUBSCRIPTION_STATUSES.includes(statusParam as (typeof SUBSCRIPTION_STATUSES)[number])
        ? (statusParam as (typeof SUBSCRIPTION_STATUSES)[number])
        : null;
    const q = url.searchParams.get("q")?.trim();

    // Phase 9 (Support tooling) — "global search": a support agent
    // usually has the OWNER's name or phone number in hand, not the
    // restaurant's own name/slug, so `q` also matches against the
    // restaurant's owner. Resolved as a separate id lookup (rather than
    // joining users into the main select below) to avoid duplicating a
    // restaurant row if it ever had more than one active "owner" grant —
    // the main select stays a clean one-row-per-restaurant query either way.
    let ownerMatchIds: string[] = [];
    if (q) {
      const ownerMatches = await db
        .select({ restaurantId: userRoles.restaurantId })
        .from(userRoles)
        .innerJoin(users, eq(userRoles.userId, users.id))
        .where(
          and(
            eq(userRoles.role, "owner"),
            or(ilike(users.fullName, `%${q}%`), ilike(users.phone, `%${q}%`)),
          ),
        );
      ownerMatchIds = ownerMatches
        .map((r) => r.restaurantId)
        .filter((id): id is string => id !== null);
    }

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
          q
            ? or(
                ilike(restaurants.name, `%${q}%`),
                ilike(restaurants.slug, `%${q}%`),
                ownerMatchIds.length > 0 ? inArray(restaurants.id, ownerMatchIds) : undefined,
              )
            : undefined,
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

    // Phase 4 — the list used to embed a static PLANS lookup client-side;
    // the catalog is DB-backed now, so this route resolves plan names
    // server-side instead. getAllPlansForAdmin (not getActivePlans) so a
    // restaurant on a since-retired plan still shows its actual name
    // rather than "—".
    const allPlans = await getAllPlansForAdmin();
    const planNameByKey = new Map(allPlans.map((p) => [p.key, p.name]));

    return NextResponse.json({
      restaurants: rows.map((r) => ({
        ...r,
        owner: ownerByRestaurant.get(r.id) ?? null,
        planName: r.planKey ? (planNameByKey.get(r.planKey) ?? r.planKey) : null,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
