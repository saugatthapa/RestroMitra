/**
 * Phase 10 integration test: proves (a) requireActiveSubscription correctly
 * allows/blocks access purely from a restaurant's subscription_status/
 * trial_ends_at, (b) the lazy self-healing reconciliation actually writes
 * "expired" + a subscription_events row back to the DB exactly once when a
 * trial is first discovered to be over — and does NOT re-write on a
 * second call, (c) requirePlatformAdmin rejects a regular owner and
 * accepts a real platform_admin, (d) requireRestaurantAccess's existing
 * platform_admin bypass still grants access regardless of a tenant's
 * subscription state, and (e) MANAGE_SUBSCRIPTION is owner-only (manager
 * denied) — the same profit-adjacent trust tier as MANAGE_EXPENSES.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Subscription access + platform admin (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");
  let subscriptionDb: typeof import("@/lib/subscription-db");

  let ownerAId: string;
  let managerAId: string;
  let platformAdminId: string;
  let platformAdminNoMfaId: string;
  let restaurantExpiredId: string;
  let restaurantActiveTrialId: string;
  let restaurantCancelledId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");
    subscriptionDb = await import("@/lib/subscription-db");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Sub Owner A", phone: `9771${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [managerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Sub Manager A", phone: `9772${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [platformAdmin] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Sub Platform Admin",
        phone: `9773${suffix.slice(0, 6)}`,
        passwordHash: "x",
        // MFA enabled — since the hardening fix in guard.ts's
        // requireRestaurantAccess, the platform_admin bypass this test
        // exercises below now requires it, same as every other
        // platform-access entry point. See the dedicated no-MFA test
        // further down for the denial case this seed is deliberately
        // avoiding here.
        mfaEnabled: true,
      })
      .returning({ id: schema.users.id });
    const [platformAdminNoMfa] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Sub Platform Admin No MFA",
        phone: `9774${suffix.slice(0, 6)}`,
        passwordHash: "x",
        mfaEnabled: false,
      })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    managerAId = managerA.id;
    platformAdminId = platformAdmin.id;
    platformAdminNoMfaId = platformAdminNoMfa.id;

    const pastTrial = new Date(Date.now() - 1000 * 60 * 60 * 24 * 5); // 5 days ago
    const futureTrial = new Date(Date.now() + 1000 * 60 * 60 * 24 * 20); // 20 days out

    const [restaurantExpired] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-sub-expired-${suffix}`,
        name: "TEST Sub Restaurant Expired",
        subscriptionStatus: "trialing",
        trialEndsAt: pastTrial,
      })
      .returning({ id: schema.restaurants.id });
    const [restaurantActiveTrial] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-sub-active-trial-${suffix}`,
        name: "TEST Sub Restaurant Active Trial",
        subscriptionStatus: "trialing",
        trialEndsAt: futureTrial,
      })
      .returning({ id: schema.restaurants.id });
    const [restaurantCancelled] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-sub-cancelled-${suffix}`,
        name: "TEST Sub Restaurant Cancelled",
        subscriptionStatus: "cancelled",
      })
      .returning({ id: schema.restaurants.id });
    restaurantExpiredId = restaurantExpired.id;
    restaurantActiveTrialId = restaurantActiveTrial.id;
    restaurantCancelledId = restaurantCancelled.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerAId, restaurantId: restaurantExpiredId, role: "owner" },
      { userId: managerAId, restaurantId: restaurantExpiredId, role: "manager" },
      { userId: platformAdminId, restaurantId: null, role: "platform_admin" },
      { userId: platformAdminNoMfaId, restaurantId: null, role: "platform_admin" },
    ]);
  });

  afterAll(async () => {
    for (const restaurantId of [restaurantExpiredId, restaurantActiveTrialId, restaurantCancelledId]) {
      await db.delete(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.restaurantId, restaurantId));
      await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    }
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, platformAdminId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, platformAdminNoMfaId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerAId));
    await db.delete(schema.users).where(eq(schema.users.id, managerAId));
    await db.delete(schema.users).where(eq(schema.users.id, platformAdminId));
    await db.delete(schema.users).where(eq(schema.users.id, platformAdminNoMfaId));
  });

  it("requireActiveSubscription allows a restaurant still inside its trial window", async () => {
    await expect(guard.requireActiveSubscription(restaurantActiveTrialId)).resolves.toBeUndefined();
  });

  it("requireActiveSubscription blocks a restaurant whose trial has lapsed, with reason trial_expired", async () => {
    await expect(guard.requireActiveSubscription(restaurantExpiredId)).rejects.toMatchObject({
      status: 402,
      reason: "trial_expired",
    });
  });

  it("the lapsed trial check wrote 'expired' back to the restaurant row exactly once, plus one trial_expired event", async () => {
    const [row] = await db
      .select({ subscriptionStatus: schema.restaurants.subscriptionStatus })
      .from(schema.restaurants)
      .where(eq(schema.restaurants.id, restaurantExpiredId));
    expect(row.subscriptionStatus).toBe("expired");

    const events = await db
      .select()
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.restaurantId, restaurantExpiredId));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("trial_expired");
    expect(events[0].fromStatus).toBe("trialing");
    expect(events[0].toStatus).toBe("expired");
    expect(events[0].performedByUserId).toBeNull(); // system-generated, not a human action

    // Calling it again must NOT insert a second event — the status is
    // already "expired", so reconcileSubscriptionStatus takes the cheap
    // read-only path this time.
    await expect(guard.requireActiveSubscription(restaurantExpiredId)).rejects.toMatchObject({
      status: 402,
      reason: "expired",
    });
    const eventsAfterSecondCall = await db
      .select()
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.restaurantId, restaurantExpiredId));
    expect(eventsAfterSecondCall).toHaveLength(1);
  });

  it("requireActiveSubscription blocks a cancelled restaurant without needing any reconciliation write", async () => {
    await expect(guard.requireActiveSubscription(restaurantCancelledId)).rejects.toMatchObject({
      status: 402,
      reason: "cancelled",
    });
    const events = await db
      .select()
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.restaurantId, restaurantCancelledId));
    expect(events).toHaveLength(0);
  });

  it("requirePlatformAdmin-equivalent check: isPlatformAdmin is false for a regular owner, true for the seeded platform admin", async () => {
    await expect(guard.isPlatformAdmin(ownerAId)).resolves.toBe(false);
    await expect(guard.isPlatformAdmin(platformAdminId)).resolves.toBe(true);
  });

  it("requireRestaurantAccess's existing platform_admin bypass grants access to an EXPIRED restaurant regardless of its subscription state", async () => {
    // This is the bypass resolveRestaurantContext relies on: platform_admin
    // access must never depend on the target tenant's own billing status.
    // (This admin has MFA enabled — see the dedicated no-MFA test below for
    // the boundary that bypass now also enforces.)
    await expect(guard.requireRestaurantAccess(platformAdminId, restaurantExpiredId)).resolves.toMatchObject({
      role: "platform_admin",
    });
  });

  // Security hardening — closes the "platform-admin MFA tenant-access
  // boundary" gap: requireRestaurantAccess's platform_admin bypass used to
  // grant tenant access with no MFA check at all, unlike every other
  // platform-access entry point (requirePlatformAdmin/
  // requirePlatformPermission). A platform_admin who never enabled MFA
  // could reach money-moving tenant-scoped routes directly — no
  // impersonation step, no impersonation audit trail. See guard.ts's
  // requireRestaurantAccess for the full fix comment.
  it("requireRestaurantAccess's platform_admin bypass now REJECTS a platform_admin who has not enabled MFA", async () => {
    await expect(guard.requireRestaurantAccess(platformAdminNoMfaId, restaurantExpiredId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("MANAGE_SUBSCRIPTION is owner-only: manager is denied with a 403", async () => {
    await expect(
      guard.requirePermission(ownerAId, restaurantExpiredId, PERMISSIONS.MANAGE_SUBSCRIPTION),
    ).resolves.toBeUndefined();
    await expect(
      guard.requirePermission(managerAId, restaurantExpiredId, PERMISSIONS.MANAGE_SUBSCRIPTION),
    ).rejects.toMatchObject({ status: 403 });
  });

  // Phase 11 security pass — the audit flagged that entitlements-db.ts's
  // hasFeature() has zero subscription-state awareness by design: it only
  // ever consults the restaurant's plan/overrides/flags, never
  // subscriptionStatus. That's safe only because every tenant-scoped route
  // funnels through resolveRestaurantContext (see api-route-helpers.ts),
  // which calls requireActiveSubscription BEFORE any permission or
  // feature check runs — so an expired tenant is rejected with 402 long
  // before a feature-gated route would ever get to ask hasFeature whether
  // the plan includes the feature. This test locks in that half of the
  // guarantee (requireActiveSubscription blocks the expired tenant) side
  // by side with the fact that hasFeature would otherwise happily grant
  // it, since the no-session-mocking limitation documented throughout
  // this project (see this file's own module comment) rules out
  // exercising resolveRestaurantContext's actual call ordering end to end.
  it("an expired tenant is blocked by requireActiveSubscription even on a plan that grants the feature — hasFeature alone would not have caught this", async () => {
    const { hasFeature } = await import("@/lib/entitlements-db");
    const { FEATURES } = await import("@/lib/feature-catalog");

    // Assign restaurantExpiredId (already reconciled to "expired" by the
    // earlier test in this file) a plan that genuinely carries
    // ai_assistant, so hasFeature has something real to grant — otherwise
    // this test would trivially pass for the wrong reason (no plan means
    // no features either way).
    const planKey = `test-sub-expired-plan-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(schema.plans).values({
      key: planKey,
      name: "TEST Expired-Tenant Plan",
      tagline: "Carries ai_assistant, to prove hasFeature alone is subscription-blind.",
      priceInPaisaMonthly: 100_000,
      maxStaff: 5,
      maxBranches: 1,
      highlight: false,
      features: [],
      featureKeys: [FEATURES.AI_ASSISTANT],
      sortOrder: 999,
      isActive: true,
    });
    await db
      .update(schema.restaurants)
      .set({ planKey })
      .where(eq(schema.restaurants.id, restaurantExpiredId));

    try {
      // hasFeature is subscription-blind by design (see entitlements-db.ts's
      // own doc comment) — it grants purely off the plan, so on its own it
      // says yes even though this tenant's subscription has lapsed.
      expect(await hasFeature(restaurantExpiredId, FEATURES.AI_ASSISTANT)).toBe(true);

      // requireActiveSubscription is what actually stands between this
      // tenant and any feature-gated route — resolveRestaurantContext
      // calls it before any permission or feature check runs (see
      // api-route-helpers.ts), so the hasFeature grant above never gets a
      // chance to matter for an expired tenant.
      await expect(guard.requireActiveSubscription(restaurantExpiredId)).rejects.toMatchObject({
        status: 402,
      });
    } finally {
      await db
        .update(schema.restaurants)
        .set({ planKey: null })
        .where(eq(schema.restaurants.id, restaurantExpiredId));
      await db.delete(schema.plans).where(eq(schema.plans.key, planKey));
    }
  });

  it("reconcileSubscriptionStatus returns allowed:true for an active restaurant without touching the DB", async () => {
    const [activeRestaurant] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-sub-active-${Math.random().toString(36).slice(2, 8)}`,
        name: "TEST Sub Restaurant Active",
        subscriptionStatus: "active",
        planKey: "growth",
      })
      .returning({ id: schema.restaurants.id });

    const access = await subscriptionDb.reconcileSubscriptionStatus(activeRestaurant.id);
    expect(access).toEqual({ allowed: true, reason: "active" });

    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, activeRestaurant.id));
  });
});
