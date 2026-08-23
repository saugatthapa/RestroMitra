/**
 * P0-2 integration test: exercises the REAL public QR order route handler
 * (not a reimplementation) against a real database, proving the
 * clientRequestId idempotency it previously entirely lacked (unlike the
 * staff order route, which has always had this). A guest's phone retrying
 * a QR order after a flaky connection — or the menu's own double-submit
 * guard racing a slow response — must never create two orders for the
 * same submission attempt.
 *
 * Follows the same "call the real exported route handler with a real
 * Request" pattern as
 * src/app/api/payments/gateway/[gateway]/callback/route.test.ts.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("POST /api/order/[token] clientRequestId idempotency (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let POST: typeof import("./route").POST;

  let restaurantId: string;
  let branchId: string;
  let qrToken: string;
  let menuItemId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    POST = (await import("./route")).POST;

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-qr-idem-${suffix}`, name: "TEST QR Idempotency Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    qrToken = `test-qr-token-${suffix}`;
    await db.insert(schema.restaurantTables).values({ restaurantId, branchId, name: "TEST Table", qrToken });

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId, name: "TEST Category" })
      .returning({ id: schema.categories.id });

    const [menuItem] = await db
      .insert(schema.menuItems)
      .values({ restaurantId, categoryId: category.id, name: "TEST Momo Plate", basePriceInPaisa: 18_000 })
      .returning({ id: schema.menuItems.id });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await db.delete(schema.orderItems).where(eq(schema.orderItems.menuItemId, menuItemId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.menuItems).where(eq(schema.menuItems.restaurantId, restaurantId));
    await db.delete(schema.categories).where(eq(schema.categories.restaurantId, restaurantId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  function submitOrder(clientRequestId: string | undefined) {
    return POST(
      new Request(`http://localhost:3100/api/order/${qrToken}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-restromitra-client": "web" },
        body: JSON.stringify({
          items: [{ menuItemId, quantity: 1, addonIds: [] }],
          ...(clientRequestId ? { clientRequestId } : {}),
        }),
      }),
      { params: Promise.resolve({ token: qrToken }) } as never,
    );
  }

  it("a retried submission with the same clientRequestId returns the original order, not a duplicate", async () => {
    const clientRequestId = crypto.randomUUID();

    const res1 = await submitOrder(clientRequestId);
    expect(res1.status).toBe(201);
    const body1 = await res1.json();
    expect(body1.idempotentReplay).toBeUndefined();

    // Simulates a flaky-connection retry: the guest's phone re-sends the
    // exact same submission (same clientRequestId) after not hearing back
    // from the first attempt in time.
    const res2 = await submitOrder(clientRequestId);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.idempotentReplay).toBe(true);
    expect(body2.order.id).toBe(body1.order.id);

    const orderRows = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.clientRequestId, clientRequestId));
    expect(orderRows).toHaveLength(1);
  });

  it("two genuinely concurrent submissions with the same clientRequestId create only ONE order", async () => {
    const clientRequestId = crypto.randomUUID();

    const [res1, res2] = await Promise.all([submitOrder(clientRequestId), submitOrder(clientRequestId)]);
    const bodies = await Promise.all([res1.json(), res2.json()]);

    // Exactly one of the two responses is the real 201 create; the other
    // is the 200 idempotent-replay that caught the 23505 race in the
    // insert's catch block (not the up-front SELECT, which both requests
    // could pass before either commits).
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 201]);

    // Both responses reference the SAME order id either way.
    expect(bodies[0].order.id).toBe(bodies[1].order.id);

    const orderRows = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.clientRequestId, clientRequestId));
    expect(orderRows).toHaveLength(1);
  });

  it("submissions with no clientRequestId are never deduplicated against each other", async () => {
    const res1 = await submitOrder(undefined);
    const res2 = await submitOrder(undefined);
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.order.id).not.toBe(body2.order.id);
  });
});
