/**
 * Platform Control Center, Phase 11 (security test pass) — regression
 * coverage for a TOCTOU race the security audit flagged: the staff-add
 * and branch-create routes (src/app/api/restaurants/[slug]/staff/route.ts,
 * .../branches/route.ts) enforce their plan's seat/branch limit with a
 * count-then-insert check. Before this phase that check ran against the
 * plain `db` handle with no lock, so two requests racing for the last slot
 * could both read the same pre-insert count and both pass, letting a
 * restaurant exceed its plan's limit by one. Both routes now wrap the
 * count-check-then-insert in a transaction that first locks the
 * restaurant row with SELECT...FOR UPDATE — the same tx-scoped
 * .for("update") pattern the order-mutation routes already use — so a
 * second transaction blocks on the lock until the first commits, then
 * re-counts and correctly sees the just-inserted row.
 *
 * This file can't invoke the route handlers directly (they depend on
 * next/headers's cookies() for the session, and this project has no
 * session-mocking harness — see subscription-permissions.test.ts's own
 * comment for the same limitation elsewhere), so it instead exercises the
 * identical lock-count-insert shape those routes now use, firing two
 * attempts concurrently against a real Postgres connection to prove the
 * lock actually serializes them. This is a DB-level proof of the
 * concurrency guarantee, not a byte-for-byte call into the route.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same convention as
 * the other DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, count, eq, ne } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Plan-limit TOCTOU race (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let plansDb: typeof import("@/lib/plans-db");

  let planKey: string;
  let ownerUserId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    plansDb = await import("@/lib/plans-db");

    const suffix = Math.random().toString(36).slice(2, 8);
    planKey = `test-race-plan-${suffix}`;

    await db.insert(schema.plans).values({
      key: planKey,
      name: "TEST Race Plan",
      tagline: "A test plan with a tight limit for race testing.",
      priceInPaisaMonthly: 100_000,
      maxStaff: 1,
      maxBranches: 1,
      highlight: false,
      features: [],
      featureKeys: [],
      sortOrder: 999,
      isActive: true,
    });

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Race Owner", phone: `9755${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerUserId = owner.id;
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.plans).where(eq(schema.plans.key, planKey));
  });

  /** Mirrors staff/route.ts POST's lock-count-insert block exactly. */
  async function attemptAddStaff(restaurantId: string, candidateUserId: string) {
    return db.transaction(async (tx) => {
      const [restaurantRow] = await tx
        .select({ planKey: schema.restaurants.planKey })
        .from(schema.restaurants)
        .where(eq(schema.restaurants.id, restaurantId))
        .for("update");
      const maxStaff = await plansDb.maxStaffForRestaurant(restaurantRow ?? { planKey: null });
      if (maxStaff !== null) {
        const [staffCountRow] = await tx
          .select({ n: count() })
          .from(schema.userRoles)
          .where(
            and(
              eq(schema.userRoles.restaurantId, restaurantId),
              eq(schema.userRoles.isActive, true),
              ne(schema.userRoles.role, "owner"),
            ),
          );
        if ((staffCountRow?.n ?? 0) >= maxStaff) {
          throw new Error("STAFF_LIMIT_REACHED");
        }
      }
      const [inserted] = await tx
        .insert(schema.userRoles)
        .values({ userId: candidateUserId, restaurantId, role: "waiter", invitedBy: ownerUserId })
        .returning();
      return inserted;
    });
  }

  /** Mirrors branches/route.ts POST's lock-count-insert block exactly. */
  async function attemptAddBranch(restaurantId: string, name: string) {
    return db.transaction(async (tx) => {
      const [restaurantRow] = await tx
        .select({ planKey: schema.restaurants.planKey })
        .from(schema.restaurants)
        .where(eq(schema.restaurants.id, restaurantId))
        .for("update");
      const maxBranches = await plansDb.maxBranchesForRestaurant(restaurantRow ?? { planKey: null });
      if (maxBranches !== null) {
        const [branchCountRow] = await tx
          .select({ n: count() })
          .from(schema.branches)
          .where(and(eq(schema.branches.restaurantId, restaurantId), eq(schema.branches.isActive, true)));
        if ((branchCountRow?.n ?? 0) >= maxBranches) {
          throw new Error("BRANCH_LIMIT_REACHED");
        }
      }
      const [inserted] = await tx
        .insert(schema.branches)
        .values({ restaurantId, name, isMain: false })
        .returning();
      return inserted;
    });
  }

  it("two concurrent staff-adds racing for the plan's one open seat: exactly one succeeds", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-race-staff-${suffix}`,
        name: "TEST Race Restaurant (staff)",
        subscriptionStatus: "active",
        planKey,
        isActive: true,
      })
      .returning({ id: schema.restaurants.id });

    const [candidateA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Race Candidate A", phone: `9756${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [candidateB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Race Candidate B", phone: `9757${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });

    const results = await Promise.allSettled([
      attemptAddStaff(restaurant.id, candidateA.id),
      attemptAddStaff(restaurant.id, candidateB.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe("STAFF_LIMIT_REACHED");

    const [finalCount] = await db
      .select({ n: count() })
      .from(schema.userRoles)
      .where(
        and(
          eq(schema.userRoles.restaurantId, restaurant.id),
          eq(schema.userRoles.isActive, true),
          ne(schema.userRoles.role, "owner"),
        ),
      );
    expect(finalCount.n).toBe(1); // NOT 2 — the race did not let it over-book the seat

    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurant.id));
    await db.delete(schema.users).where(eq(schema.users.id, candidateA.id));
    await db.delete(schema.users).where(eq(schema.users.id, candidateB.id));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurant.id));
  });

  it("two concurrent branch-creates racing for the plan's one open branch slot: exactly one succeeds", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-race-branch-${suffix}`,
        name: "TEST Race Restaurant (branch)",
        subscriptionStatus: "active",
        planKey,
        isActive: true,
      })
      .returning({ id: schema.restaurants.id });

    const results = await Promise.allSettled([
      attemptAddBranch(restaurant.id, "TEST Branch A"),
      attemptAddBranch(restaurant.id, "TEST Branch B"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe("BRANCH_LIMIT_REACHED");

    const [finalCount] = await db
      .select({ n: count() })
      .from(schema.branches)
      .where(and(eq(schema.branches.restaurantId, restaurant.id), eq(schema.branches.isActive, true)));
    expect(finalCount.n).toBe(1); // NOT 2

    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurant.id));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurant.id));
  });
});
