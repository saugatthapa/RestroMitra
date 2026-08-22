/**
 * Integration test for the realtime branch/table filter-before-LIMIT fix
 * (src/lib/realtime.ts). Both fetchEventsForRestaurant and
 * fetchServiceCallEventsForTable used to run `ORDER BY id LIMIT 200` over
 * EVERY event for the restaurant first, then filter down to the caller's
 * own branch/table in JS. That meant a branch (or table) whose own
 * relevant events happened to land after 200+ OTHER branches'/tables'
 * events since the caller's last-seen id would never even see them — cut
 * off by the limit before the JS filter ever ran, and gone for good since
 * the caller's cursor advances past whatever batch it does see.
 *
 * This proves the fix by reproducing exactly that shape: 200 "noise"
 * events for a different branch, THEN one real event for the branch under
 * test, then asserting the branch-scoped fetch still returns it.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);
const NOISE_COUNT = 205; // comfortably past the 200-row LIMIT

describe.skipIf(!hasDb)("realtime branch/table filtering before LIMIT (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let realtime: typeof import("@/lib/realtime");

  let restaurantId: string;
  let branchAId: string;
  let branchBId: string;
  let tableAId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    realtime = await import("@/lib/realtime");
    const { generateQrToken } = await import("@/lib/qr");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-realtime-filter-${suffix}`, name: "TEST Realtime Filter Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch A", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch B" })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [tableA] = await db
      .insert(schema.restaurantTables)
      .values({ restaurantId, branchId: branchAId, name: "TEST Table A", qrToken: generateQrToken() })
      .returning({ id: schema.restaurantTables.id });
    tableAId = tableA.id;
  });

  afterAll(async () => {
    await db.delete(schema.realtimeEvents).where(eq(schema.realtimeEvents.restaurantId, restaurantId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("a branch-scoped caller still sees their own event after 200+ other-branch events crowd the id window", async () => {
    for (let i = 0; i < NOISE_COUNT; i++) {
      await realtime.publishEvent(db, {
        restaurantId,
        branchId: branchBId,
        type: "order.created",
        payload: { noise: i },
      });
    }

    await realtime.publishEvent(db, {
      restaurantId,
      branchId: branchAId,
      type: "order.created",
      payload: { marker: "branch-a-event" },
    });

    const fetchForA = realtime.fetchEventsForRestaurant(restaurantId, branchAId);
    const events = await fetchForA(0);

    const marker = events.find((e) => (e.payload as { marker?: string }).marker === "branch-a-event");
    expect(marker).toBeDefined();
  });

  it("a branch-scoped caller never sees another branch's events, even unrestricted by the id window", async () => {
    const fetchForA = realtime.fetchEventsForRestaurant(restaurantId, branchAId);
    const events = await fetchForA(0);
    const leaked = events.find((e) => (e.payload as { noise?: number }).noise !== undefined);
    expect(leaked).toBeUndefined();
  });

  it("an unrestricted (null branchId) caller isn't branch-filtered at all (still capped at the same 200-row page size)", async () => {
    const fetchUnrestricted = realtime.fetchEventsForRestaurant(restaurantId, null);
    const events = await fetchUnrestricted(0);
    // No branch filter applies for an unrestricted caller, so this is
    // purely exercising normal pagination — the 200-row LIMIT is a real,
    // intentional page size, not the bug. The bug was branch-scoped
    // callers losing events to *other* branches' noise inside that same
    // limit; an unrestricted caller has no "other branch" to lose events
    // to in the first place.
    expect(events.length).toBe(200);
  });

  it("a table-scoped guest stream still sees their own service_call event after 200+ other events crowd the id window", async () => {
    for (let i = 0; i < NOISE_COUNT; i++) {
      await realtime.publishEvent(db, {
        restaurantId,
        branchId: branchBId,
        type: "order.created",
        payload: { noise: i },
      });
    }

    await realtime.publishEvent(db, {
      restaurantId,
      branchId: branchAId,
      type: "service_call.created",
      payload: { tableId: tableAId, marker: "table-a-service-call" },
    });

    const fetchForTable = realtime.fetchServiceCallEventsForTable(restaurantId, tableAId);
    const events = await fetchForTable(0);

    const marker = events.find((e) => (e.payload as { marker?: string }).marker === "table-a-service-call");
    expect(marker).toBeDefined();
    // Every returned event must actually be this table's own service_call —
    // no order.created noise, no other table's service_call.
    for (const e of events) {
      expect(e.type.startsWith("service_call.")).toBe(true);
      expect((e.payload as { tableId?: string }).tableId).toBe(tableAId);
    }
  });
});
