import "server-only";
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
};

/** All restaurants this user has an active role grant on. */
export async function getUserRestaurants(
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
    })
    .from(userRoles)
    .innerJoin(restaurants, eq(userRoles.restaurantId, restaurants.id))
    .where(and(eq(userRoles.userId, userId), eq(userRoles.isActive, true)));

  return rows;
}

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
