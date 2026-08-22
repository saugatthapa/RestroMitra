/**
 * Integration test for the RBAC multi-active-role fix.
 *
 * requireRestaurantAccess() (src/lib/rbac/guard.ts) resolves a user's
 * access at one restaurant via a single-row lookup (`.limit(1)`), which is
 * only safe because the app enforces "at most one ACTIVE user_roles row
 * per (user, restaurant)" — the staff POST route already checked this on
 * create, but the staff PATCH route's reactivation path (isActive: true
 * on a previously-deactivated grant) did not check for an already-active
 * OTHER grant first, so a user could end up with two simultaneously
 * active roles at the same restaurant (e.g. removed as waiter@BranchA,
 * re-added as manager@BranchB, then the old waiter@BranchA row gets
 * reactivated too) — at which point requireRestaurantAccess's arbitrary
 * single-row pick would decide, unpredictably, which role/branch scope
 * actually applies to that user's requests.
 *
 * This proves the real backstop: user_roles_one_active_per_restaurant_unique
 * (a partial unique index on (user_id, restaurant_id) WHERE is_active),
 * added in schema.ts specifically so the invariant holds structurally —
 * for every current and future code path, not just the ones that
 * remember to check — the same "matches zero rows" / constraint-violation
 * pattern order-status-permissions.test.ts and ledger-settlement-race.
 * test.ts use elsewhere in this project.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("user_roles: at most one active grant per (user, restaurant) (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let userId: string;
  let restaurantId: string;
  let branchAId: string;
  let branchBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Multi-Role User", phone: `9712${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-single-active-role-${suffix}`, name: "TEST Single Active Role Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch A", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch B" })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;
  });

  afterAll(async () => {
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("inserting a second concurrently-active grant for the same user+restaurant is rejected by the DB", async () => {
    await db.insert(schema.userRoles).values({
      userId,
      restaurantId,
      branchId: branchAId,
      role: "waiter",
      isActive: true,
    });

    await expect(
      db.insert(schema.userRoles).values({
        userId,
        restaurantId,
        branchId: branchBId,
        role: "manager",
        isActive: true,
      }),
    ).rejects.toThrow();
  });

  it("a deactivated grant can coexist with a separate active one (the invariant is about ACTIVE grants only)", async () => {
    // The first grant from the previous test is still active; adding an
    // inactive one for the same user+restaurant must NOT be blocked — a
    // user's history of past (deactivated) grants is exactly what the
    // partial index is designed to allow to accumulate freely.
    await expect(
      db.insert(schema.userRoles).values({
        userId,
        restaurantId,
        branchId: branchBId,
        role: "kitchen_staff",
        isActive: false,
      }),
    ).resolves.not.toThrow();
  });

  it("reactivating that deactivated grant while another grant is still active is also rejected by the DB", async () => {
    const [inactiveGrant] = await db
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(eq(schema.userRoles.role, "kitchen_staff"));

    // This is exactly the PATCH route's reactivation path the application
    // code now guards explicitly — this test proves the DB itself refuses
    // it even if that application-level check were ever removed or
    // bypassed by a different code path.
    await expect(
      db
        .update(schema.userRoles)
        .set({ isActive: true })
        .where(eq(schema.userRoles.id, inactiveGrant.id)),
    ).rejects.toThrow();
  });
});
