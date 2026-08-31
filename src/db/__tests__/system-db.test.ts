/**
 * Platform Control Center (Phase 10) — System (announcements + maintenance
 * mode). Integration tests for:
 *  - announcements-db.ts's getActiveAnnouncements filtering (delegates to
 *    the already pure-unit-tested isAnnouncementCurrentlyShowable, so this
 *    just proves the DB read wires that filter correctly);
 *  - maintenance-mode-db.ts's singleton upsert semantics (lazy row
 *    creation on first read, enabled/disabled round-trip, reason cleared
 *    on disable);
 *  - guard.ts's requireNotInMaintenanceMode — the actual enforcement
 *    point every tenant-scoped API route funnels through via
 *    resolveRestaurantContext.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("System: announcements + maintenance mode (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let announcementsDb: typeof import("@/lib/system/announcements-db");
  let maintenanceDb: typeof import("@/lib/system/maintenance-mode-db");
  let guard: typeof import("@/lib/rbac/guard");

  let adminUserId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    announcementsDb = await import("@/lib/system/announcements-db");
    maintenanceDb = await import("@/lib/system/maintenance-mode-db");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [admin] = await db
      .insert(schema.users)
      .values({ fullName: "TEST System Admin", phone: `9794${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    adminUserId = admin.id;
  });

  afterEach(async () => {
    // Always leave maintenance mode OFF between tests so unrelated
    // DB-integration tests elsewhere in the suite (which also exercise
    // recordAuditLog/resolveRestaurantContext-style code paths) never
    // observe it left on by this file.
    await maintenanceDb.setMaintenanceMode({
      enabled: false,
      message: null,
      reason: null,
      userId: adminUserId,
    });
    await db.delete(schema.platformAnnouncements).where(eq(schema.platformAnnouncements.createdByUserId, adminUserId));
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  });

  describe("announcements-db", () => {
    it("getActiveAnnouncements only returns currently-showable ones", async () => {
      const active = await announcementsDb.createAnnouncement({
        title: "TEST active",
        body: "shown now",
        severity: "info",
        startsAt: null,
        endsAt: null,
        createdByUserId: adminUserId,
      });
      const inactive = await announcementsDb.createAnnouncement({
        title: "TEST inactive",
        body: "not shown",
        severity: "info",
        startsAt: null,
        endsAt: null,
        createdByUserId: adminUserId,
      });
      await announcementsDb.setAnnouncementActive(inactive.id, false);

      const future = await announcementsDb.createAnnouncement({
        title: "TEST future",
        body: "not yet",
        severity: "warning",
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        endsAt: null,
        createdByUserId: adminUserId,
      });

      const shown = await announcementsDb.getActiveAnnouncements();
      const shownIds = shown.map((a) => a.id);
      expect(shownIds).toContain(active.id);
      expect(shownIds).not.toContain(inactive.id);
      expect(shownIds).not.toContain(future.id);
    });

    it("listAllAnnouncements includes inactive ones (the admin console view)", async () => {
      const created = await announcementsDb.createAnnouncement({
        title: "TEST list-all",
        body: "body",
        severity: "critical",
        startsAt: null,
        endsAt: null,
        createdByUserId: adminUserId,
      });
      await announcementsDb.setAnnouncementActive(created.id, false);

      const all = await announcementsDb.listAllAnnouncements();
      expect(all.map((a) => a.id)).toContain(created.id);
    });

    it("deleteAnnouncement removes it and returns false on a second delete", async () => {
      const created = await announcementsDb.createAnnouncement({
        title: "TEST delete-me",
        body: "body",
        severity: "info",
        startsAt: null,
        endsAt: null,
        createdByUserId: adminUserId,
      });
      expect(await announcementsDb.deleteAnnouncement(created.id)).toBe(true);
      expect(await announcementsDb.deleteAnnouncement(created.id)).toBe(false);
    });
  });

  describe("maintenance-mode-db", () => {
    it("defaults to disabled with no prior row", async () => {
      const state = await maintenanceDb.getMaintenanceMode();
      expect(state.enabled).toBe(false);
    });

    it("enabling round-trips message/reason/enabledBy, disabling clears them", async () => {
      await maintenanceDb.setMaintenanceMode({
        enabled: true,
        message: "Down for upgrades",
        reason: "TEST scheduled DB migration",
        userId: adminUserId,
      });
      const enabledState = await maintenanceDb.getMaintenanceMode();
      expect(enabledState.enabled).toBe(true);
      expect(enabledState.message).toBe("Down for upgrades");
      expect(enabledState.reason).toBe("TEST scheduled DB migration");
      expect(enabledState.enabledByName).toBe("TEST System Admin");
      expect(enabledState.enabledAt).not.toBeNull();

      await maintenanceDb.setMaintenanceMode({
        enabled: false,
        message: null,
        reason: null,
        userId: adminUserId,
      });
      const disabledState = await maintenanceDb.getMaintenanceMode();
      expect(disabledState.enabled).toBe(false);
      expect(disabledState.message).toBeNull();
      expect(disabledState.reason).toBeNull();
      expect(disabledState.enabledAt).toBeNull();
    });
  });

  describe("guard.ts requireNotInMaintenanceMode", () => {
    it("throws MaintenanceModeActiveError for a plain tenant role when maintenance mode is on", async () => {
      await maintenanceDb.setMaintenanceMode({
        enabled: true,
        message: "TEST maintenance message",
        reason: "TEST reason",
        userId: adminUserId,
      });

      await expect(guard.requireNotInMaintenanceMode("owner")).rejects.toThrow(
        guard.MaintenanceModeActiveError,
      );
      await expect(guard.requireNotInMaintenanceMode("owner")).rejects.toThrow(
        "TEST maintenance message",
      );
    });

    it("never throws for platform_admin or either impersonation role, even when maintenance mode is on", async () => {
      await maintenanceDb.setMaintenanceMode({
        enabled: true,
        message: null,
        reason: "TEST reason",
        userId: adminUserId,
      });

      await expect(guard.requireNotInMaintenanceMode("platform_admin")).resolves.toBeUndefined();
      await expect(guard.requireNotInMaintenanceMode("impersonated_read")).resolves.toBeUndefined();
      await expect(guard.requireNotInMaintenanceMode("impersonated_write")).resolves.toBeUndefined();
    });

    it("never throws for any role when maintenance mode is off", async () => {
      await maintenanceDb.setMaintenanceMode({
        enabled: false,
        message: null,
        reason: null,
        userId: adminUserId,
      });
      await expect(guard.requireNotInMaintenanceMode("owner")).resolves.toBeUndefined();
      await expect(guard.requireNotInMaintenanceMode("waiter")).resolves.toBeUndefined();
    });
  });
});
