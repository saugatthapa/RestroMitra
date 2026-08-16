/**
 * Phase 11b integration test: proves the `orders_restaurant_client_request_id_unique`
 * partial index actually enforces what the offline-POS sync flow depends on
 * — a client-generated clientRequestId can only ever back ONE order per
 * restaurant, so a retried submission (offline sync, or a request whose
 * response never made it back) can't create a duplicate. This is the
 * schema-level guarantee; the orders POST route's idempotent-replay
 * handling (returning the original order instead of erroring on the
 * collision) is covered end-to-end by scripts/smoke-test-phase11b.sh.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("orders.client_request_id uniqueness (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantAId: string;
  let restaurantBId: string;
  let branchAId: string;
  let branchBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-idem-a-${suffix}`, name: "TEST Idempotency Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-idem-b-${suffix}`, name: "TEST Idempotency Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "TEST Branch A", isMain: true })
      .returning({ id: schema.branches.id });
    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantBId, name: "TEST Branch B", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;
    branchBId = branchB.id;
  });

  afterAll(async () => {
    for (const restaurantId of [restaurantAId, restaurantBId]) {
      await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
      await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    }
  });

  function orderRow(restaurantId: string, branchId: string, clientRequestId: string | null) {
    return {
      restaurantId,
      branchId,
      orderNumber: `TEST-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      source: "pos" as const,
      status: "pending" as const,
      clientRequestId,
      subtotalInPaisa: 10_000,
      taxInPaisa: 0,
      totalInPaisa: 10_000,
    };
  }

  it("rejects a second order with the same clientRequestId for the same restaurant", async () => {
    const clientRequestId = crypto.randomUUID();
    await db.insert(schema.orders).values(orderRow(restaurantAId, branchAId, clientRequestId));

    // drizzle-orm wraps the underlying postgres.js error in a
    // DrizzleQueryError — the actual Postgres error code lives on `.cause`.
    await expect(
      db.insert(schema.orders).values(orderRow(restaurantAId, branchAId, clientRequestId)),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows the SAME clientRequestId across two different restaurants", async () => {
    const clientRequestId = crypto.randomUUID();
    const [a] = await db
      .insert(schema.orders)
      .values(orderRow(restaurantAId, branchAId, clientRequestId))
      .returning();
    const [b] = await db
      .insert(schema.orders)
      .values(orderRow(restaurantBId, branchBId, clientRequestId))
      .returning();

    expect(a.clientRequestId).toBe(clientRequestId);
    expect(b.clientRequestId).toBe(clientRequestId);
    expect(a.id).not.toBe(b.id);
  });

  it("allows unlimited orders with a null clientRequestId (ordinary QR/staff orders never collide)", async () => {
    const [first] = await db
      .insert(schema.orders)
      .values(orderRow(restaurantAId, branchAId, null))
      .returning();
    const [second] = await db
      .insert(schema.orders)
      .values(orderRow(restaurantAId, branchAId, null))
      .returning();

    expect(first.clientRequestId).toBeNull();
    expect(second.clientRequestId).toBeNull();
  });
});
