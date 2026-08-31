/**
 * Platform Control Center (Phase 8) — Impersonation. Integration tests for
 * the security-critical DB-level invariants:
 *
 *  - No nested impersonation: `platform_impersonation_sessions_one_active_
 *    per_admin_unique` (a partial unique index on admin_user_id WHERE
 *    status = 'active') must hold even under genuine concurrency, not just
 *    a check-then-insert race in application code (spec item 32).
 *  - Ending a session (status flips away from 'active') must free up that
 *    admin to start a new one.
 *  - The constraint is scoped to ONE admin — it must never block two
 *    different admins from each running their own concurrent session.
 *  - target_restaurant_id is ON DELETE CASCADE — deleting a restaurant
 *    must never leave an orphaned impersonation session row behind.
 *  - revokeImpersonationSession() (src/lib/auth/impersonation.ts) — the
 *    one function in that module with no `cookies()` dependency, so it's
 *    directly callable here — correctly force-ends another admin's active
 *    session and is a no-op (returns false) once already inactive.
 *
 * startImpersonation()/getImpersonationContext()/exitImpersonation() all
 * read/write the impersonation cookie via next/headers' cookies(), which
 * (same situation as getSession() in session.ts — see destroy-other-
 * sessions.test.ts's own comment) is not callable outside an active
 * Next.js request context and has no session-mocking harness in this
 * project. This suite instead proves the invariants those functions
 * actually depend on directly, at the DB level — the same approach this
 * project already uses for every other CAS/race-condition guarantee (see
 * attendance-open-shift-race.test.ts).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("platform_impersonation_sessions (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let isUniqueViolation: typeof import("@/lib/db-error").isUniqueViolation;
  let revokeImpersonationSession: typeof import("@/lib/auth/impersonation").revokeImpersonationSession;

  let restaurantAId: string;
  let restaurantBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    isUniqueViolation = (await import("@/lib/db-error")).isUniqueViolation;
    ({ revokeImpersonationSession } = await import("@/lib/auth/impersonation"));

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-impersonation-a-${suffix}`, name: "TEST Impersonation Restaurant A" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;

    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-impersonation-b-${suffix}`, name: "TEST Impersonation Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantBId = restaurantB.id;
  });

  afterAll(async () => {
    await db.delete(schema.platformImpersonationSessions).where(
      eq(schema.platformImpersonationSessions.targetRestaurantId, restaurantAId),
    );
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.fullName, "TEST Impersonation Admin"));
  });

  async function createAdmin() {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Impersonation Admin", phone: `97${suffix.slice(0, 8)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    return user.id;
  }

  async function startSession(
    adminUserId: string,
    targetRestaurantId: string,
    overrides: Partial<{ status: "active" | "ended" | "expired" | "revoked"; mode: "read_only" | "write" }> = {},
  ) {
    return db
      .insert(schema.platformImpersonationSessions)
      .values({
        tokenHash: Math.random().toString(36).slice(2),
        adminUserId,
        targetRestaurantId,
        reason: "TEST reason",
        mode: overrides.mode ?? "read_only",
        status: overrides.status ?? "active",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      })
      .returning();
  }

  it("rejects a second ACTIVE impersonation session for the same admin (no nested impersonation)", async () => {
    const adminId = await createAdmin();
    await startSession(adminId, restaurantAId);

    await expect(startSession(adminId, restaurantAId)).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err),
    );
    // Also rejected when the second attempt targets a DIFFERENT restaurant
    // — the constraint is "one active session per admin", not "one active
    // session per admin per restaurant".
    await expect(startSession(adminId, restaurantBId)).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err),
    );
  });

  it("allows a new active session once the admin's prior one is no longer active", async () => {
    const adminId = await createAdmin();
    await startSession(adminId, restaurantAId, { status: "ended" });

    const [created] = await startSession(adminId, restaurantAId);
    expect(created.status).toBe("active");
  });

  it("does not constrain different admins from each other", async () => {
    const adminA = await createAdmin();
    const adminB = await createAdmin();
    await startSession(adminA, restaurantAId);
    const [createdB] = await startSession(adminB, restaurantAId);
    expect(createdB.adminUserId).toBe(adminB);
  });

  it("under genuine concurrency, exactly one of two simultaneous start attempts for the same admin wins", async () => {
    const adminId = await createAdmin();
    const attempt = () =>
      startSession(adminId, restaurantAId)
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const failure = outcomes.find((o) => !o.ok) as { ok: false; err: unknown };
    expect(isUniqueViolation(failure.err)).toBe(true);

    const activeSessions = await db
      .select({ id: schema.platformImpersonationSessions.id })
      .from(schema.platformImpersonationSessions)
      .where(
        and(
          eq(schema.platformImpersonationSessions.adminUserId, adminId),
          eq(schema.platformImpersonationSessions.status, "active"),
        ),
      );
    expect(activeSessions).toHaveLength(1);
  });

  it("deleting the target restaurant cascades to delete its impersonation session rows", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [scratchRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-impersonation-cascade-${suffix}`, name: "TEST Impersonation Cascade Restaurant" })
      .returning({ id: schema.restaurants.id });

    const adminId = await createAdmin();
    const [session] = await startSession(adminId, scratchRestaurant.id);

    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, scratchRestaurant.id));

    const remaining = await db
      .select({ id: schema.platformImpersonationSessions.id })
      .from(schema.platformImpersonationSessions)
      .where(eq(schema.platformImpersonationSessions.id, session.id));
    expect(remaining).toHaveLength(0);
  });

  describe("revokeImpersonationSession", () => {
    it("force-ends an active session: flips status to 'revoked', sets endedAt and endedByUserId", async () => {
      const adminId = await createAdmin();
      const revokerId = await createAdmin();
      const [session] = await startSession(adminId, restaurantAId);

      const result = await revokeImpersonationSession(session.id, revokerId);
      expect(result).toBe(true);

      const [row] = await db
        .select()
        .from(schema.platformImpersonationSessions)
        .where(eq(schema.platformImpersonationSessions.id, session.id));
      expect(row.status).toBe("revoked");
      expect(row.endedAt).not.toBeNull();
      expect(row.endedByUserId).toBe(revokerId);
    });

    it("is a no-op (returns false) when the session is already inactive", async () => {
      const adminId = await createAdmin();
      const revokerId = await createAdmin();
      const [session] = await startSession(adminId, restaurantAId, { status: "ended" });

      const result = await revokeImpersonationSession(session.id, revokerId);
      expect(result).toBe(false);

      const [row] = await db
        .select({ status: schema.platformImpersonationSessions.status })
        .from(schema.platformImpersonationSessions)
        .where(eq(schema.platformImpersonationSessions.id, session.id));
      // Still "ended" — revoke must never overwrite a different terminal status.
      expect(row.status).toBe("ended");
    });

    it("revoking one admin's session never touches another admin's active session", async () => {
      const adminA = await createAdmin();
      const adminB = await createAdmin();
      const revokerId = await createAdmin();
      const [sessionA] = await startSession(adminA, restaurantAId);
      const [sessionB] = await startSession(adminB, restaurantBId);

      await revokeImpersonationSession(sessionA.id, revokerId);

      const [rowB] = await db
        .select({ status: schema.platformImpersonationSessions.status })
        .from(schema.platformImpersonationSessions)
        .where(eq(schema.platformImpersonationSessions.id, sessionB.id));
      expect(rowB.status).toBe("active");
    });
  });

  describe("isPlatformOrImpersonatedRole (guard.ts)", () => {
    it("is true for platform_admin and both impersonation pseudo-roles, false for every real staff role", async () => {
      // guard.ts imports "@/db" at module scope (it needs DATABASE_URL to
      // even load), so this is dynamically imported here rather than at
      // file scope — same reason every other db-touching import in this
      // suite is dynamic, see the top-of-file comment.
      const { isPlatformOrImpersonatedRole } = await import("@/lib/rbac/guard");

      expect(isPlatformOrImpersonatedRole("platform_admin")).toBe(true);
      expect(isPlatformOrImpersonatedRole("impersonated_read")).toBe(true);
      expect(isPlatformOrImpersonatedRole("impersonated_write")).toBe(true);

      for (const role of ["owner", "manager", "cashier", "waiter", "kitchen_staff", "accountant"]) {
        expect(isPlatformOrImpersonatedRole(role)).toBe(false);
      }
    });
  });
});
