/**
 * Gap audit (P1) integration test: "MFA is not enforced for restaurant
 * owners, only for platform admins... it's just not mandatory for the role
 * (owner) that controls a restaurant's financial data."
 *
 * Proves requireOwnerMfaEnabled (the tenant-scoped mirror of
 * requirePlatformMfaEnabled in guard.ts) and shouldShowOwnerMfaWarning (the
 * pure predicate behind dashboard/layout.tsx's non-blocking banner):
 *
 *  (a) an owner without MFA is NOT blocked by requireOwnerMfaEnabled from
 *      basic access — it only throws for the specific opt-in call sites
 *      (the gated financial routes), never as a blanket gate — and
 *      shouldShowOwnerMfaWarning correctly says to show the warning banner
 *      for exactly that owner.
 *  (b) an owner without MFA IS rejected, with a clear/actionable 403, when
 *      requireOwnerMfaEnabled is actually called (the gated financial
 *      routes' shared check).
 *  (c) an owner with MFA enabled passes both (a)'s no-block guarantee and
 *      (b)'s gate cleanly, and shouldShowOwnerMfaWarning says NOT to show
 *      the banner.
 *  (d) non-owner roles (manager, accountant, platform_admin, an
 *      impersonation role) are completely unaffected by
 *      requireOwnerMfaEnabled regardless of their own MFA status — this is
 *      the guarantee that a co-worker sharing the same permission (e.g.
 *      MANAGE_PAYROLL, REFUND_ORDER) on a gated route is never blocked by
 *      the OWNER's MFA state, and shouldShowOwnerMfaWarning never shows the
 *      owner-specific banner to them.
 *
 * Session-dependent routing (an actual HTTP request through
 * resolveRestaurantContext's `requireOwnerMfa` opt-in) isn't exercised here
 * — this project has no session-mocking harness for API route handlers
 * (see platform-authorization.test.ts's own comment on the identical
 * limitation for requirePlatformAdmin). requireOwnerMfaEnabled itself takes
 * a plain (userId, role) — no session — so it, and the pure banner
 * predicate, are fully exercised directly against the real DB below.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same convention as the
 * other DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Restaurant owner MFA enforcement (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let restaurantId: string;
  let ownerNoMfaId: string;
  let ownerWithMfaId: string;
  let managerNoMfaId: string;
  let accountantNoMfaId: string;
  let platformAdminNoMfaId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);
    const mkPhone = (n: number) => `9760${n}${suffix.slice(0, 5)}`;

    const [ownerNoMfa] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Owner No MFA", phone: mkPhone(1), passwordHash: "x", mfaEnabled: false })
      .returning({ id: schema.users.id });
    const [ownerWithMfa] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Owner With MFA", phone: mkPhone(2), passwordHash: "x", mfaEnabled: true })
      .returning({ id: schema.users.id });
    const [managerNoMfa] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Manager No MFA", phone: mkPhone(3), passwordHash: "x", mfaEnabled: false })
      .returning({ id: schema.users.id });
    const [accountantNoMfa] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant No MFA", phone: mkPhone(4), passwordHash: "x", mfaEnabled: false })
      .returning({ id: schema.users.id });
    const [platformAdminNoMfa] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Platform Admin No MFA", phone: mkPhone(5), passwordHash: "x", mfaEnabled: false })
      .returning({ id: schema.users.id });

    ownerNoMfaId = ownerNoMfa.id;
    ownerWithMfaId = ownerWithMfa.id;
    managerNoMfaId = managerNoMfa.id;
    accountantNoMfaId = accountantNoMfa.id;
    platformAdminNoMfaId = platformAdminNoMfa.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({
        slug: `test-owner-mfa-${suffix}`,
        name: "TEST Owner MFA Restaurant",
        subscriptionStatus: "active",
      })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerNoMfaId, restaurantId, role: "owner" },
      { userId: ownerWithMfaId, restaurantId, role: "owner" },
      { userId: managerNoMfaId, restaurantId, role: "manager" },
      { userId: accountantNoMfaId, restaurantId, role: "accountant" },
      { userId: platformAdminNoMfaId, restaurantId: null, role: "platform_admin" },
    ]);
  });

  afterAll(async () => {
    const userIds = [
      ownerNoMfaId,
      ownerWithMfaId,
      managerNoMfaId,
      accountantNoMfaId,
      platformAdminNoMfaId,
    ];
    await db.delete(schema.userRoles).where(inArray(schema.userRoles.userId, userIds));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  });

  describe("(a) an owner without MFA is never blanket-blocked", () => {
    it("requireOwnerMfaEnabled is opt-in per call site, not a blanket gate — an owner without MFA hits no error until a gated call site invokes it", async () => {
      // Basic reachability (requireRestaurantAccess — what every ordinary
      // dashboard view/POS/order-taking route funnels through) is
      // completely untouched by MFA status.
      await expect(
        guard.requireRestaurantAccess(ownerNoMfaId, restaurantId),
      ).resolves.toMatchObject({ role: "owner" });
    });

    it("shouldShowOwnerMfaWarning says to show the banner for this exact owner", () => {
      expect(
        guard.shouldShowOwnerMfaWarning({
          isImpersonating: false,
          role: "owner",
          mfaEnabled: false,
        }),
      ).toBe(true);
    });

    it("shouldShowOwnerMfaWarning never fires during an impersonation session, even if the flag were somehow role=owner", () => {
      expect(
        guard.shouldShowOwnerMfaWarning({
          isImpersonating: true,
          role: "owner",
          mfaEnabled: false,
        }),
      ).toBe(false);
    });
  });

  describe("(b) an owner without MFA IS rejected at a gated financial action, with a clear/actionable error", () => {
    it("requireOwnerMfaEnabled throws a 403 naming MFA and where to enable it", async () => {
      await expect(guard.requireOwnerMfaEnabled(ownerNoMfaId, "owner")).rejects.toMatchObject({
        status: 403,
      });
      try {
        await guard.requireOwnerMfaEnabled(ownerNoMfaId, "owner");
        throw new Error("expected requireOwnerMfaEnabled to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).toMatch(/MFA/i);
        expect(message).toMatch(/\/dashboard\/account/);
      }
    });
  });

  describe("(c) an owner WITH MFA enabled passes cleanly", () => {
    it("requireOwnerMfaEnabled resolves without throwing", async () => {
      await expect(guard.requireOwnerMfaEnabled(ownerWithMfaId, "owner")).resolves.toBeUndefined();
    });

    it("basic restaurant access still resolves normally", async () => {
      await expect(
        guard.requireRestaurantAccess(ownerWithMfaId, restaurantId),
      ).resolves.toMatchObject({ role: "owner" });
    });

    it("shouldShowOwnerMfaWarning says NOT to show the banner", () => {
      expect(
        guard.shouldShowOwnerMfaWarning({
          isImpersonating: false,
          role: "owner",
          mfaEnabled: true,
        }),
      ).toBe(false);
    });
  });

  describe("(d) non-owner roles are completely unaffected, regardless of their own MFA status", () => {
    it("a manager without MFA passes requireOwnerMfaEnabled (no-op for non-owner roles)", async () => {
      await expect(guard.requireOwnerMfaEnabled(managerNoMfaId, "manager")).resolves.toBeUndefined();
    });

    it("an accountant without MFA passes requireOwnerMfaEnabled — same shared-permission actions (e.g. MANAGE_PAYROLL), untouched by the owner's own MFA gate", async () => {
      await expect(
        guard.requireOwnerMfaEnabled(accountantNoMfaId, "accountant"),
      ).resolves.toBeUndefined();
    });

    it("a platform_admin without MFA passes requireOwnerMfaEnabled — their own MFA requirement is enforced separately, one layer up, at requirePlatformAdmin/requirePlatformPermission", async () => {
      await expect(
        guard.requireOwnerMfaEnabled(platformAdminNoMfaId, "platform_admin"),
      ).resolves.toBeUndefined();
    });

    it("an active impersonation role passes requireOwnerMfaEnabled regardless of the underlying admin's MFA status", async () => {
      await expect(
        guard.requireOwnerMfaEnabled(platformAdminNoMfaId, "impersonated_write"),
      ).resolves.toBeUndefined();
      await expect(
        guard.requireOwnerMfaEnabled(platformAdminNoMfaId, "impersonated_read"),
      ).resolves.toBeUndefined();
    });

    it("shouldShowOwnerMfaWarning never shows the owner-specific banner to a non-owner role", () => {
      for (const role of ["manager", "accountant", "cashier", "waiter", "platform_admin", "impersonated_write"]) {
        expect(
          guard.shouldShowOwnerMfaWarning({ isImpersonating: false, role, mfaEnabled: false }),
        ).toBe(false);
      }
    });
  });

  describe("real-world shared-permission scenario: REFUND_ORDER holders", () => {
    it("MANAGE_PAYROLL/REFUND_ORDER-style permission checks pass for both owner and manager identically — requireOwnerMfaEnabled is a separate, additional gate layered only on top of the owner's own path", async () => {
      const { PERMISSIONS } = await import("@/lib/rbac/permissions");
      await expect(
        guard.requirePermission(ownerNoMfaId, restaurantId, PERMISSIONS.REFUND_ORDER),
      ).resolves.toBeUndefined();
      await expect(
        guard.requirePermission(managerNoMfaId, restaurantId, PERMISSIONS.REFUND_ORDER),
      ).resolves.toBeUndefined();

      // The permission check alone (what a route without requireOwnerMfa
      // relies on) never distinguishes MFA state — only the additional,
      // explicit requireOwnerMfaEnabled call does, and only for the owner.
      await expect(guard.requireOwnerMfaEnabled(ownerNoMfaId, "owner")).rejects.toMatchObject({
        status: 403,
      });
      await expect(guard.requireOwnerMfaEnabled(managerNoMfaId, "manager")).resolves.toBeUndefined();
    });
  });
});
