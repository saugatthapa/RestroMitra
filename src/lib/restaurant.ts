import "server-only";
import { cache } from "react";
import { eq, and, asc, desc } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, userRoles, branches } from "@/db/schema";

export type OwnedRestaurant = {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  // Phase 17 — printed at the top of every Kitchen Order Ticket; null falls
  // back to `name` at render time (see kot.ts's buildKotHeaderText).
  kotHeaderText: string | null;
  role: string;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  planKey: string | null;
  onboardingCompletedAt: Date | null;
  // Phase 2 — Platform Control Center suspension flag (see guard.ts's
  // requireRestaurantActive). Surfaced here so the dashboard layout can
  // redirect a suspended restaurant's staff to /suspended the same way it
  // already redirects an inactive subscription to /billing.
  isActive: boolean;
};

async function getUserRestaurantsUncached(
  userId: string,
): Promise<OwnedRestaurant[]> {
  const rows = await db
    .select({
      id: restaurants.id,
      slug: restaurants.slug,
      name: restaurants.name,
      logoUrl: restaurants.logoUrl,
      kotHeaderText: restaurants.kotHeaderText,
      role: userRoles.role,
      subscriptionStatus: restaurants.subscriptionStatus,
      trialEndsAt: restaurants.trialEndsAt,
      planKey: restaurants.planKey,
      onboardingCompletedAt: restaurants.onboardingCompletedAt,
      isActive: restaurants.isActive,
    })
    .from(userRoles)
    .innerJoin(restaurants, eq(userRoles.restaurantId, restaurants.id))
    .where(and(eq(userRoles.userId, userId), eq(userRoles.isActive, true)));

  return rows;
}

/**
 * All restaurants this user has an active role grant on.
 *
 * Perf audit (PERFORMANCE_AUDIT.md, Phase 25) — dashboard/layout.tsx and
 * dashboard/page.tsx both independently called this with the same userId
 * during the same request's render. React's cache() dedupes that to one
 * query per request; see the matching comment on getSession() in
 * lib/auth/session.ts for why this is safe to also call from Route
 * Handlers (it just runs uncached there, with no cross-request sharing).
 */
export const getUserRestaurants = cache(getUserRestaurantsUncached);

export async function getRestaurantForUser(userId: string, restaurantId: string) {
  const rows = await db
    .select({
      id: restaurants.id,
      slug: restaurants.slug,
      name: restaurants.name,
      type: restaurants.type,
      subscriptionStatus: restaurants.subscriptionStatus,
      trialEndsAt: restaurants.trialEndsAt,
      role: userRoles.role,
    })
    .from(userRoles)
    .innerJoin(restaurants, eq(userRoles.restaurantId, restaurants.id))
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.restaurantId, restaurantId),
        eq(userRoles.isActive, true),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Phase 8 (Platform Control Center) — fetches the full `OwnedRestaurant`
 * shape for a restaurant an admin is IMPERSONATING, keyed purely on
 * restaurantId (no userId/userRoles join — an impersonating admin
 * deliberately has no real role grant on this restaurant; that's the
 * whole point of the feature). Caller (dashboard/layout.tsx) is
 * responsible for having already validated the impersonation context
 * itself (see getImpersonationContext) — this is just the data lookup,
 * with `role` filled in by the caller from the impersonation mode rather
 * than from any DB row here.
 *
 * Returns null if the restaurant no longer exists, which in practice
 * should be unreachable during a live impersonation session: the
 * platform_impersonation_sessions.target_restaurant_id FK is
 * ON DELETE CASCADE, so deleting a restaurant also deletes any of its
 * active impersonation session rows.
 */
export async function getRestaurantForImpersonation(
  restaurantId: string,
): Promise<Omit<OwnedRestaurant, "role"> | null> {
  const rows = await db
    .select({
      id: restaurants.id,
      slug: restaurants.slug,
      name: restaurants.name,
      logoUrl: restaurants.logoUrl,
      kotHeaderText: restaurants.kotHeaderText,
      subscriptionStatus: restaurants.subscriptionStatus,
      trialEndsAt: restaurants.trialEndsAt,
      planKey: restaurants.planKey,
      onboardingCompletedAt: restaurants.onboardingCompletedAt,
      isActive: restaurants.isActive,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);

  return rows[0] ?? null;
}

export async function getMainBranch(restaurantId: string) {
  const rows = await db
    .select()
    .from(branches)
    .where(and(eq(branches.restaurantId, restaurantId), eq(branches.isMain, true)))
    .limit(1);
  return rows[0] ?? null;
}

export type SelectableBranch = { id: string; name: string; isMain: boolean };

/**
 * Branches a user may switch between in the dashboard header (and filter
 * Reports by) — every active branch of the restaurant, UNLESS this user's
 * own role grant is locked to one specific branch (userRoles.branchId —
 * see requireBranchAccess in rbac/guard.ts), in which case that's the only
 * "selectable" branch. There's nothing to switch between for a
 * branch-locked staff member, so the header switcher naturally disappears
 * (DashboardShell only renders it when this list has more than one entry)
 * rather than needing a separate permission check to hide it.
 */
export async function getSelectableBranches(
  userId: string,
  restaurantId: string,
): Promise<SelectableBranch[]> {
  const grantRows = await db
    .select({ branchId: userRoles.branchId })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.restaurantId, restaurantId),
        eq(userRoles.isActive, true),
      ),
    )
    .limit(1);
  const lockedBranchId = grantRows[0]?.branchId ?? null;

  const rows = await db
    .select({ id: branches.id, name: branches.name, isMain: branches.isMain })
    .from(branches)
    .where(
      and(
        eq(branches.restaurantId, restaurantId),
        eq(branches.isActive, true),
        ...(lockedBranchId ? [eq(branches.id, lockedBranchId)] : []),
      ),
    )
    .orderBy(desc(branches.isMain), asc(branches.createdAt));

  return rows;
}
