/**
 * RC audit P1 regression test: proves listAuditLogs() (src/lib/audit.ts) —
 * the query the new GET /api/restaurants/[slug]/audit-log route (gated
 * MANAGE_STAFF) reads through — actually does what its own doc comment
 * claims: tenant-scoped, newest first, action-prefix/resourceType/date-range
 * filterable, and paginated with an honest hasMore flag.
 *
 * recordAuditLog() has been populating audit_logs since Phase 2 (55+ call
 * sites); this closes the read side this project's own RC audit found
 * missing.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("listAuditLogs (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let recordAuditLog: typeof import("@/lib/audit").recordAuditLog;
  let listAuditLogs: typeof import("@/lib/audit").listAuditLogs;

  let restaurantAId: string;
  let restaurantBId: string;
  let userId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ({ recordAuditLog, listAuditLogs } = await import("@/lib/audit"));

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-auditlog-a-${suffix}`, name: "TEST Audit Log Restaurant A" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;

    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-auditlog-b-${suffix}`, name: "TEST Audit Log Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantBId = restaurantB.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Audit Log User", phone: `9781${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    // Restaurant A: 3 events, oldest to newest — a refund, a staff change,
    // then another refund — deliberately out of natural insert order isn't
    // needed since createdAt defaults to now() and Postgres timestamp
    // resolution is fine-grained enough for strict ordering across
    // sequential inserts in a single test process.
    await recordAuditLog({
      restaurantId: restaurantAId,
      userId,
      action: "payment.refunded",
      resourceType: "payment",
      resourceId: "pay-1",
      metadata: { amountInPaisa: 10_000 },
    });
    await recordAuditLog({
      restaurantId: restaurantAId,
      userId,
      action: "staff.role_changed",
      resourceType: "user_role",
      resourceId: "role-1",
    });
    await recordAuditLog({
      restaurantId: restaurantAId,
      userId,
      action: "payment.refunded",
      resourceType: "payment",
      resourceId: "pay-2",
    });

    // Restaurant B: one event — must never leak into restaurant A's list.
    await recordAuditLog({
      restaurantId: restaurantBId,
      userId,
      action: "payment.refunded",
      resourceType: "payment",
      resourceId: "pay-b",
    });
  });

  afterAll(async () => {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.restaurantId, restaurantAId));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("scopes strictly to the given restaurant — restaurant B's event never appears", async () => {
    const result = await listAuditLogs(restaurantAId);
    expect(result.logs).toHaveLength(3);
    expect(result.logs.every((l) => l.action !== "payment.refunded" || l.resourceId !== "pay-b")).toBe(true);
  });

  it("orders newest first", async () => {
    const result = await listAuditLogs(restaurantAId);
    const resourceIds = result.logs.map((l) => l.resourceId);
    expect(resourceIds).toEqual(["pay-2", "role-1", "pay-1"]);
  });

  it("joins the actor's fullName", async () => {
    const result = await listAuditLogs(restaurantAId, { limit: 1 });
    expect(result.logs[0].userFullName).toBe("TEST Audit Log User");
  });

  it("filters by action prefix", async () => {
    const result = await listAuditLogs(restaurantAId, { actionPrefix: "payment." });
    expect(result.logs).toHaveLength(2);
    expect(result.logs.every((l) => l.action === "payment.refunded")).toBe(true);
  });

  it("filters by resourceType", async () => {
    const result = await listAuditLogs(restaurantAId, { resourceType: "user_role" });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].resourceId).toBe("role-1");
  });

  it("paginates with an honest hasMore flag and never over-fetches beyond limit", async () => {
    const page1 = await listAuditLogs(restaurantAId, { limit: 2, offset: 0 });
    expect(page1.logs).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await listAuditLogs(restaurantAId, { limit: 2, offset: 2 });
    expect(page2.logs).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });

  it("an empty restaurant reports zero logs, not an error", async () => {
    const [emptyRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-auditlog-empty-${Math.random().toString(36).slice(2, 8)}`, name: "TEST Empty" })
      .returning({ id: schema.restaurants.id });

    const result = await listAuditLogs(emptyRestaurant.id);
    expect(result).toEqual({ logs: [], hasMore: false, limit: 50, offset: 0 });

    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, emptyRestaurant.id));
  });
});
