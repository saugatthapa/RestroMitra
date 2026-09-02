/**
 * QA hardening (P2 backlog, RESTROMITRA_MASTER_GAP_AUDIT.md): "No test
 * explicitly proves KDS branch-visibility (the underlying shared
 * authorization pattern strongly implies it's already enforced, just not
 * directly tested by name)."
 *
 * The Kitchen Display Screen (KDSBoard.tsx) has no API route of its own —
 * it fetches from this exact GET /api/restaurants/[slug]/orders endpoint
 * (the same one OrdersBoard uses) and filters the response down to
 * kitchen-relevant statuses (confirmed/preparing/ready — see KDS_COLUMNS
 * in KDSBoard.tsx) client-side. So "KDS branch-visibility" is really a
 * question about THIS route's own branch scoping: a branch-scoped kitchen
 * device must never receive another branch's orders in the response body
 * at all, since the client-side status filter is the only thing standing
 * between "never sent" and "briefly rendered, then filtered out."
 *
 * Exercises the REAL GET route handler (not a reimplementation) against a
 * REAL database with real orders in two branches, same "call the real
 * exported route handler with a real Request" pattern as
 * src/app/order/[token]/route.test.ts and
 * src/app/api/admin/audit-log/route.test.ts. Only the session/cookie
 * boundary (resolveRestaurantContext) is mocked, to a branch-scoped
 * context matching a real userRoles grant seeded below — the DB query
 * that actually decides which orders come back runs for real, which is
 * the part this gap is about.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

const resolveRestaurantContext = vi.fn();
vi.mock("@/lib/api-route-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-route-helpers")>(
    "@/lib/api-route-helpers",
  );
  return {
    ...actual,
    resolveRestaurantContext: (...args: unknown[]) => resolveRestaurantContext(...args),
  };
});

function sessionFor(userId: string) {
  return {
    sessionId: "test-session-id",
    user: { id: userId, fullName: "TEST Kitchen Staff", phone: "9770000002", email: null },
    activeRestaurantId: null,
  };
}

describe.skipIf(!hasDb)("GET /api/restaurants/[slug]/orders branch visibility (KDS, integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let slug: string;
  let branchAId: string;
  let branchBId: string;
  let staffAId: string;
  let staffBId: string;
  let unrestrictedOwnerId: string;

  const orderIds: string[] = [];

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);
    slug = `test-kds-branch-vis-${suffix}`;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug, name: "TEST KDS Branch Visibility Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Kitchen Branch A", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Kitchen Branch B" })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [staffA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Kitchen Staff A", phone: `9703${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    staffAId = staffA.id;

    const [staffB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Kitchen Staff B", phone: `9704${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    staffBId = staffB.id;

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Owner (all branches)", phone: `9705${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    unrestrictedOwnerId = owner.id;

    await db.insert(schema.userRoles).values([
      { userId: staffAId, restaurantId, branchId: branchAId, role: "kitchen_staff" },
      { userId: staffBId, restaurantId, branchId: branchBId, role: "kitchen_staff" },
      { userId: unrestrictedOwnerId, restaurantId, role: "owner" },
    ]);

    // Kitchen-relevant orders (KDS_COLUMNS: confirmed/preparing/ready) in
    // EACH branch, so a leak would show up as a real order object in the
    // wrong branch's response, not just an empty-vs-nonempty difference.
    const [orderA] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId: branchAId,
        orderNumber: `TEST-KDS-A-${suffix}`,
        source: "pos",
        status: "preparing",
        subtotalInPaisa: 500_00,
        taxInPaisa: 0,
        totalInPaisa: 500_00,
      })
      .returning({ id: schema.orders.id });
    const [orderB] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId: branchBId,
        orderNumber: `TEST-KDS-B-${suffix}`,
        source: "pos",
        status: "confirmed",
        subtotalInPaisa: 700_00,
        taxInPaisa: 0,
        totalInPaisa: 700_00,
      })
      .returning({ id: schema.orders.id });
    orderIds.push(orderA.id, orderB.id);
  });

  afterAll(async () => {
    for (const id of orderIds) {
      await db.delete(schema.orders).where(eq(schema.orders.id, id));
    }
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, staffAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, staffBId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, unrestrictedOwnerId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    for (const id of [staffAId, staffBId, unrestrictedOwnerId]) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  it("a branch-A-scoped kitchen device sees branch A's order and NEVER branch B's", async () => {
    resolveRestaurantContext.mockResolvedValue({
      session: sessionFor(staffAId),
      restaurantId,
      role: "kitchen_staff",
      branchId: branchAId,
      timezone: "Asia/Kathmandu",
    });
    const { GET } = await import("./route");

    const res = await GET(
      new Request(`http://localhost:3100/api/restaurants/${slug}/orders`),
      { params: Promise.resolve({ slug }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // The direct, by-name proof this gap called out: branch A's order is
    // present, branch B's order — the exact one a leak would surface — is
    // not, not even filtered client-side (KDSBoard never even receives it).
    expect(body.orders.some((o: { orderNumber: string }) => o.orderNumber.startsWith("TEST-KDS-A-"))).toBe(true);
    expect(body.orders.some((o: { orderNumber: string }) => o.orderNumber.startsWith("TEST-KDS-B-"))).toBe(false);
  });

  it("a branch-B-scoped kitchen device sees branch B's order and NEVER branch A's", async () => {
    resolveRestaurantContext.mockResolvedValue({
      session: sessionFor(staffBId),
      restaurantId,
      role: "kitchen_staff",
      branchId: branchBId,
      timezone: "Asia/Kathmandu",
    });
    const { GET } = await import("./route");

    const res = await GET(
      new Request(`http://localhost:3100/api/restaurants/${slug}/orders`),
      { params: Promise.resolve({ slug }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders.some((o: { orderNumber: string }) => o.orderNumber.startsWith("TEST-KDS-A-"))).toBe(false);
    expect(body.orders.some((o: { orderNumber: string }) => o.orderNumber.startsWith("TEST-KDS-B-"))).toBe(true);
  });

  it("an unrestricted owner (no branch grant) sees BOTH branches' orders by default", async () => {
    resolveRestaurantContext.mockResolvedValue({
      session: sessionFor(unrestrictedOwnerId),
      restaurantId,
      role: "owner",
      branchId: null,
      timezone: "Asia/Kathmandu",
    });
    const { GET } = await import("./route");

    const res = await GET(
      new Request(`http://localhost:3100/api/restaurants/${slug}/orders`),
      { params: Promise.resolve({ slug }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders.some((o: { orderNumber: string }) => o.orderNumber.startsWith("TEST-KDS-A-"))).toBe(true);
    expect(body.orders.some((o: { orderNumber: string }) => o.orderNumber.startsWith("TEST-KDS-B-"))).toBe(true);
  });

  it("an unrestricted owner narrowing via ?branchId= sees only that branch's order", async () => {
    resolveRestaurantContext.mockResolvedValue({
      session: sessionFor(unrestrictedOwnerId),
      restaurantId,
      role: "owner",
      branchId: null,
      timezone: "Asia/Kathmandu",
    });
    const { GET } = await import("./route");

    const res = await GET(
      new Request(`http://localhost:3100/api/restaurants/${slug}/orders?branchId=${branchAId}`),
      { params: Promise.resolve({ slug }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders.some((o: { orderNumber: string }) => o.orderNumber.startsWith("TEST-KDS-A-"))).toBe(true);
    expect(body.orders.some((o: { orderNumber: string }) => o.orderNumber.startsWith("TEST-KDS-B-"))).toBe(false);
  });
});
