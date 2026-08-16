/**
 * Phase 12 integration test: proves the DB-touching helpers in
 * src/lib/tables.ts against a real Postgres round trip — the reservation
 * double-booking overlap check, the capacity guard, syncTableStatusFromOrders'
 * derivation against real order rows, and out_of_service enforcement.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Table status lifecycle helpers (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let tablesLib: typeof import("@/lib/tables");

  let ownerId: string;
  let restaurantId: string;
  let branchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    tablesLib = await import("@/lib/tables");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Tables Owner", phone: `9769${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tables-lifecycle-${suffix}`, name: "TEST Tables Lifecycle Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    await db.insert(schema.userRoles).values([{ userId: ownerId, restaurantId, role: "owner" }]);
  });

  afterAll(async () => {
    await db.delete(schema.reservations).where(eq(schema.reservations.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  async function makeTable(name: string, capacity: number | null = 4) {
    const [table] = await db
      .insert(schema.restaurantTables)
      .values({
        restaurantId,
        branchId,
        name,
        capacity,
        qrToken: `test-qr-${Math.random().toString(36).slice(2, 10)}`,
      })
      .returning();
    return table;
  }

  it("assertNoReservationOverlap throws for an overlapping window and allows a non-overlapping one", async () => {
    const table = await makeTable("TEST Overlap Table");
    await db.insert(schema.reservations).values({
      restaurantId,
      customerName: "TEST Existing Party",
      customerPhone: "9812340001",
      partySize: 2,
      tableId: table.id,
      reservationTime: new Date("2026-11-01T18:00:00.000Z"),
      durationMinutes: 90,
      createdByUserId: ownerId,
    });

    await expect(
      db.transaction((tx) =>
        tablesLib.assertNoReservationOverlap(tx, {
          restaurantId,
          tableId: table.id,
          reservationTime: new Date("2026-11-01T18:30:00.000Z"),
          durationMinutes: 60,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      db.transaction((tx) =>
        tablesLib.assertNoReservationOverlap(tx, {
          restaurantId,
          tableId: table.id,
          reservationTime: new Date("2026-11-01T20:00:00.000Z"),
          durationMinutes: 60,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("assertNoReservationOverlap excludes cancelled/no_show reservations and the reservation being edited", async () => {
    const table = await makeTable("TEST Overlap Table 2");
    await db
      .insert(schema.reservations)
      .values({
        restaurantId,
        customerName: "TEST Cancelled Party",
        customerPhone: "9812340002",
        partySize: 2,
        tableId: table.id,
        reservationTime: new Date("2026-11-02T18:00:00.000Z"),
        durationMinutes: 90,
        status: "cancelled",
        createdByUserId: ownerId,
      });

    // A cancelled reservation never holds the table, so the same window is
    // free again.
    await expect(
      db.transaction((tx) =>
        tablesLib.assertNoReservationOverlap(tx, {
          restaurantId,
          tableId: table.id,
          reservationTime: new Date("2026-11-02T18:00:00.000Z"),
          durationMinutes: 90,
        }),
      ),
    ).resolves.toBeUndefined();

    const [active] = await db
      .insert(schema.reservations)
      .values({
        restaurantId,
        customerName: "TEST Active Party",
        customerPhone: "9812340003",
        partySize: 2,
        tableId: table.id,
        reservationTime: new Date("2026-11-02T19:00:00.000Z"),
        durationMinutes: 60,
        createdByUserId: ownerId,
      })
      .returning();

    // Editing the SAME reservation's own window shouldn't trip over itself.
    await expect(
      db.transaction((tx) =>
        tablesLib.assertNoReservationOverlap(tx, {
          restaurantId,
          tableId: table.id,
          reservationTime: new Date("2026-11-02T19:15:00.000Z"),
          durationMinutes: 60,
          excludingReservationId: active.id,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("assertPartyFitsCapacity throws only when capacity is set and exceeded", () => {
    expect(() => tablesLib.assertPartyFitsCapacity(4, 4)).not.toThrow();
    expect(() => tablesLib.assertPartyFitsCapacity(4, 5)).toThrow();
    expect(() => tablesLib.assertPartyFitsCapacity(null, 50)).not.toThrow();
  });

  it("syncTableStatusFromOrders derives status from real order rows and skips out_of_service tables", async () => {
    const table = await makeTable("TEST Sync Table");

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        tableId: table.id,
        orderNumber: `TEST-${Math.random().toString(36).slice(2, 8)}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa: 10000,
        taxInPaisa: 0,
        totalInPaisa: 10000,
      })
      .returning();

    await db.transaction((tx) => tablesLib.syncTableStatusFromOrders(tx, table.id));
    let [reloaded] = await db
      .select()
      .from(schema.restaurantTables)
      .where(eq(schema.restaurantTables.id, table.id));
    expect(reloaded.status).toBe("occupied");

    await db.update(schema.orders).set({ status: "served" }).where(eq(schema.orders.id, order.id));
    await db.transaction((tx) => tablesLib.syncTableStatusFromOrders(tx, table.id));
    [reloaded] = await db.select().from(schema.restaurantTables).where(eq(schema.restaurantTables.id, table.id));
    expect(reloaded.status).toBe("payment_pending");

    // Manually mark the table out_of_service, then confirm order activity
    // no longer silently clears it.
    await db
      .update(schema.restaurantTables)
      .set({ status: "out_of_service" })
      .where(eq(schema.restaurantTables.id, table.id));
    await db.update(schema.orders).set({ status: "completed" }).where(eq(schema.orders.id, order.id));
    await db.transaction((tx) => tablesLib.syncTableStatusFromOrders(tx, table.id));
    [reloaded] = await db.select().from(schema.restaurantTables).where(eq(schema.restaurantTables.id, table.id));
    expect(reloaded.status).toBe("out_of_service");
  });

  it("assertTableAcceptsOrders throws for an out_of_service table and no-ops for a null tableId", async () => {
    const table = await makeTable("TEST OOS Table");
    await db
      .update(schema.restaurantTables)
      .set({ status: "out_of_service" })
      .where(eq(schema.restaurantTables.id, table.id));

    await expect(
      db.transaction((tx) => tablesLib.assertTableAcceptsOrders(tx, table.id)),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      db.transaction((tx) => tablesLib.assertTableAcceptsOrders(tx, null)),
    ).resolves.toBeUndefined();
  });
});
