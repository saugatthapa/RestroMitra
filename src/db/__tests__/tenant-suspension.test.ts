/**
 * Platform Control Center, Phase 2 — integration test for the tenant
 * suspension gate: guard.ts's requireRestaurantActive (backing
 * resolveRestaurantContext's API-layer check and dashboard/layout.tsx's
 * UI-layer check), and that it's independent of subscription status.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same convention as
 * the other DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Tenant suspension gate (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let activeRestaurantId: string;
  let suspendedRestaurantId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [activeRestaurant] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-suspend-active-${suffix}`,
        name: "TEST Suspend Active",
        subscriptionStatus: "active",
        planKey: "growth",
        isActive: true,
      })
      .returning({ id: schema.restaurants.id });
    const [suspendedRestaurant] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-suspend-suspended-${suffix}`,
        name: "TEST Suspend Suspended",
        // Deliberately ACTIVE subscription status — suspension must be
        // enforced independent of billing state, not derived from it.
        subscriptionStatus: "active",
        planKey: "growth",
        isActive: false,
      })
      .returning({ id: schema.restaurants.id });

    activeRestaurantId = activeRestaurant.id;
    suspendedRestaurantId = suspendedRestaurant.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, activeRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, suspendedRestaurantId));
  });

  it("requireRestaurantActive resolves for a normal, active restaurant", async () => {
    await expect(guard.requireRestaurantActive(activeRestaurantId)).resolves.toBeUndefined();
  });

  it("requireRestaurantActive throws TenantSuspendedError (403) for a suspended restaurant, even with an active subscription", async () => {
    await expect(guard.requireRestaurantActive(suspendedRestaurantId)).rejects.toMatchObject({
      status: 403,
    });
    await expect(guard.requireRestaurantActive(suspendedRestaurantId)).rejects.toBeInstanceOf(
      guard.TenantSuspendedError,
    );
  });

  it("reactivating (isActive back to true) clears the block", async () => {
    await db
      .update(schema.restaurants)
      .set({ isActive: true })
      .where(eq(schema.restaurants.id, suspendedRestaurantId));

    await expect(guard.requireRestaurantActive(suspendedRestaurantId)).resolves.toBeUndefined();

    // restore for afterAll's assumptions / test isolation, in case another
    // test in this file runs after this one against the same row
    await db
      .update(schema.restaurants)
      .set({ isActive: false })
      .where(eq(schema.restaurants.id, suspendedRestaurantId));
  });

  it("requireRestaurantActive is a no-op (never throws) for a restaurant id that doesn't exist", async () => {
    // Mirrors requireActiveSubscription/reconcileSubscriptionStatus's own
    // convention of not being the place that 404s on a bad id — the
    // caller (requireRestaurantBySlug) already resolved and validated the
    // id before this ever runs.
    await expect(
      guard.requireRestaurantActive("00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
  });
});
