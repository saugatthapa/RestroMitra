/**
 * Platform Control Center (Phase 6) — integration test for
 * listPlatformAuditLogs() (src/lib/audit.ts), the query the platform-wide
 * audit log viewer (/admin/audit-log, GET /api/admin/audit-log) reads
 * through. Proves it spans every tenant AND platform-only events by
 * default, and that the `restaurantId` filter (a specific tenant, or
 * `null` for platform-only) actually narrows correctly — the one behavior
 * that distinguishes this from listAuditLogs' strict single-tenant scope
 * (see audit-log-list.test.ts).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same convention as the
 * other DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, isNull } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("listPlatformAuditLogs (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let recordAuditLog: typeof import("@/lib/audit").recordAuditLog;
  let listPlatformAuditLogs: typeof import("@/lib/audit").listPlatformAuditLogs;

  let restaurantAId: string;
  let restaurantBId: string;
  let userId: string;
  const suffix = Math.random().toString(36).slice(2, 8);
  const platformAction = `test_platform_action_${suffix}`;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ({ recordAuditLog, listPlatformAuditLogs } = await import("@/lib/audit"));

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-pal-a-${suffix}`, name: "TEST Platform Audit Log Restaurant A" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;

    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-pal-b-${suffix}`, name: "TEST Platform Audit Log Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantBId = restaurantB.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Platform Audit Log User", phone: `9782${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await recordAuditLog({
      restaurantId: restaurantAId,
      userId,
      action: platformAction,
      resourceType: "test",
      resourceId: "a-1",
    });
    await recordAuditLog({
      restaurantId: restaurantBId,
      userId,
      action: platformAction,
      resourceType: "test",
      resourceId: "b-1",
    });
    // Platform-level event — no tenant at all, e.g. a role grant or plan edit.
    await recordAuditLog({
      restaurantId: null,
      userId,
      action: platformAction,
      resourceType: "test",
      resourceId: "platform-1",
    });
  });

  afterAll(async () => {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.restaurantId, restaurantAId));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("with no restaurantId filter, sees events across every tenant plus platform-only events", async () => {
    const result = await listPlatformAuditLogs({ actionPrefix: platformAction });
    const resourceIds = result.logs.map((l) => l.resourceId).sort();
    expect(resourceIds).toEqual(["a-1", "b-1", "platform-1"]);
  });

  it("restaurantId: a specific tenant id narrows to just that tenant's event", async () => {
    const result = await listPlatformAuditLogs({ actionPrefix: platformAction, restaurantId: restaurantAId });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].resourceId).toBe("a-1");
    expect(result.logs[0].restaurantName).toBe("TEST Platform Audit Log Restaurant A");
  });

  it("restaurantId: null narrows to platform-only events (no tenant)", async () => {
    const result = await listPlatformAuditLogs({ actionPrefix: platformAction, restaurantId: null });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].resourceId).toBe("platform-1");
    expect(result.logs[0].restaurantId).toBeNull();
    expect(result.logs[0].restaurantName).toBeNull();
  });

  it("joins the restaurant name for a tenant-scoped row", async () => {
    const result = await listPlatformAuditLogs({ actionPrefix: platformAction, restaurantId: restaurantBId });
    expect(result.logs[0].restaurantName).toBe("TEST Platform Audit Log Restaurant B");
  });

  it("sanity: the platform-only row really has no restaurantId in the DB (not just filtered out)", async () => {
    const rows = await db.select().from(schema.auditLogs).where(isNull(schema.auditLogs.restaurantId));
    expect(rows.some((r) => r.resourceId === "platform-1")).toBe(true);
  });
});
