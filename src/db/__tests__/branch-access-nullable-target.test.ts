/**
 * Integration test for requireBranchAccessForNullableTarget (QA hardening
 * pass — branch-isolation audit). This is the shared helper behind the
 * P0 fix for staff/payroll/staff-salary routes: a branch-scoped manager
 * holding MANAGE_STAFF or MANAGE_PAYROLL used to be able to reset the
 * password of / edit / view the salary of / pay ANY staff member at the
 * restaurant, including one scoped to a DIFFERENT branch or one with an
 * unrestricted (restaurant-wide) grant — because those routes checked
 * tenant (restaurantId) isolation but never re-verified branch access
 * against the TARGET staff member's own branchId, unlike every sibling
 * route on the same resource (see requireBranchAccess itself, which this
 * codebase already uses everywhere else for a resource whose branchId is
 * NOT NULL — a userRoles grant is the one case where the target's own
 * branchId can itself be null, meaning "unrestricted").
 *
 * Covers every branch of the truth table: unrestricted caller vs.
 * branch-scoped caller, crossed with a branch-scoped target, a
 * DIFFERENT-branch target, and an unrestricted (null) target.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("requireBranchAccessForNullableTarget (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let requireBranchAccessForNullableTarget: typeof import("@/lib/rbac/guard").requireBranchAccessForNullableTarget;
  let AuthError: typeof import("@/lib/rbac/guard").AuthError;

  let restaurantId: string;
  let branchAId: string;
  let branchBId: string;
  let unrestrictedManagerId: string;
  let branchAManagerId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    const guard = await import("@/lib/rbac/guard");
    requireBranchAccessForNullableTarget = guard.requireBranchAccessForNullableTarget;
    AuthError = guard.AuthError;

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-branch-nullable-target-${suffix}`, name: "TEST Branch Nullable Target Restaurant" })
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

    const [unrestrictedManager] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Unrestricted Manager", phone: `9747${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    unrestrictedManagerId = unrestrictedManager.id;
    await db.insert(schema.userRoles).values({
      userId: unrestrictedManagerId,
      restaurantId,
      branchId: null,
      role: "manager",
    });

    const [branchAManager] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Branch A Manager", phone: `9748${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    branchAManagerId = branchAManager.id;
    await db.insert(schema.userRoles).values({
      userId: branchAManagerId,
      restaurantId,
      branchId: branchAId,
      role: "manager",
    });
  });

  afterAll(async () => {
    if (!db || !schema) return;
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("an unrestricted caller may act on a branch-scoped target", async () => {
    await expect(
      requireBranchAccessForNullableTarget(unrestrictedManagerId, restaurantId, branchAId),
    ).resolves.toBeUndefined();
  });

  it("an unrestricted caller may act on an unrestricted (null-branch) target", async () => {
    await expect(
      requireBranchAccessForNullableTarget(unrestrictedManagerId, restaurantId, null),
    ).resolves.toBeUndefined();
  });

  it("a branch-scoped caller may act on a target scoped to their OWN branch", async () => {
    await expect(
      requireBranchAccessForNullableTarget(branchAManagerId, restaurantId, branchAId),
    ).resolves.toBeUndefined();
  });

  it("a branch-scoped caller is DENIED for a target scoped to a DIFFERENT branch — the core fix", async () => {
    await expect(
      requireBranchAccessForNullableTarget(branchAManagerId, restaurantId, branchBId),
    ).rejects.toThrow(AuthError);
  });

  it("a branch-scoped caller is DENIED for an unrestricted (restaurant-wide) target — the other half of the fix", async () => {
    // This is the exact scenario the audit flagged: a branch-scoped
    // manager resetting the password of / editing / viewing the salary of
    // a restaurant-wide (branchId: null) staff member — e.g. another
    // manager or the owner — must fail closed, since a branch-scoped
    // caller has no branch to legitimately claim that target under.
    await expect(
      requireBranchAccessForNullableTarget(branchAManagerId, restaurantId, null),
    ).rejects.toThrow(AuthError);
  });
});
