/**
 * Integration test for the P0-3 fix: the "Call staff" button
 * (src/app/api/order/[token]/service-call/route.ts) used to guard against
 * duplicate active calls with a plain SELECT-then-INSERT — no locking, no
 * DB-level backstop. Two requests for the same table close enough together
 * (a guest double-tapping fast enough to beat one round trip, or two
 * retries from a flaky mobile connection) could both pass the SELECT
 * before either INSERT committed, producing two simultaneous "pending"
 * service calls for one table and duplicate alerts on staff screens.
 *
 * The fix adds `service_calls_one_active_per_table_unique` — a partial
 * unique index on (table_id) WHERE status IN ('pending', 'acknowledged') —
 * so the invariant holds at the database level regardless of application
 * timing. This test proves the constraint itself, directly and
 * deterministically (inserting two active calls for the same table without
 * relying on real race timing), plus the genuinely-concurrent variant, and
 * confirms the constraint does NOT over-constrain (resolved calls don't
 * count; different tables are independent).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("service_calls_one_active_per_table_unique (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let isUniqueViolation: typeof import("@/lib/db-error").isUniqueViolation;

  let restaurantId: string;
  let branchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    isUniqueViolation = (await import("@/lib/db-error")).isUniqueViolation;

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-service-call-race-${suffix}`, name: "TEST Service Call Race Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main Branch", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;
  });

  // Each test gets its own freshly-created table so tests are independent
  // of each other's leftover active/resolved calls — the constraint under
  // test is scoped per-table, so sharing one table across tests would make
  // earlier tests' rows leak into later assertions.
  async function createTable() {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [table] = await db
      .insert(schema.restaurantTables)
      .values({ restaurantId, branchId, name: `TEST Table ${suffix}`, qrToken: `test-qr-${suffix}` })
      .returning({ id: schema.restaurantTables.id });
    return table.id;
  }

  afterAll(async () => {
    await db.delete(schema.serviceCalls).where(eq(schema.serviceCalls.restaurantId, restaurantId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function insertCall(tableId: string, status: "pending" | "acknowledged" | "resolved") {
    return db.insert(schema.serviceCalls).values({ restaurantId, branchId, tableId, status }).returning();
  }

  it("rejects a second pending call for a table that already has one active", async () => {
    const tableId = await createTable();
    await insertCall(tableId, "pending");

    await expect(insertCall(tableId, "pending")).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err),
    );
  });

  it("rejects a pending call when an existing call for the table is only acknowledged (not yet resolved)", async () => {
    const tableId = await createTable();
    await insertCall(tableId, "acknowledged");

    await expect(insertCall(tableId, "pending")).rejects.toSatisfy((err: unknown) =>
      isUniqueViolation(err),
    );
  });

  it("allows a new call once the table's prior call is resolved", async () => {
    const tableId = await createTable();
    await insertCall(tableId, "resolved");

    const [created] = await insertCall(tableId, "pending");
    expect(created.status).toBe("pending");
  });

  it("does not constrain different tables from each other", async () => {
    const tableAId = await createTable();
    const tableBId = await createTable();
    await insertCall(tableAId, "pending");
    const [createdB] = await insertCall(tableBId, "pending");
    expect(createdB.tableId).toBe(tableBId);
  });

  it("under genuine concurrency, exactly one of two simultaneous inserts for the same table wins", async () => {
    const tableId = await createTable();
    const attempt = () =>
      insertCall(tableId, "pending")
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const failure = failed[0] as { ok: false; err: unknown };
    expect(isUniqueViolation(failure.err)).toBe(true);

    const activeForTable = await db.query.serviceCalls.findMany({
      where: and(
        eq(schema.serviceCalls.tableId, tableId),
        inArray(schema.serviceCalls.status, ["pending", "acknowledged"]),
      ),
    });
    // Exactly one active call, no matter how the race landed.
    expect(activeForTable).toHaveLength(1);
  });
});
