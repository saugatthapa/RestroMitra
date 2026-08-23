/**
 * Integration test for the P0-4 fix: sendPushToRestaurant() (src/lib/
 * push.ts) used to notify EVERY push subscription for a restaurant,
 * regardless of which branch the underlying event (a new order, a Call
 * Staff tap) actually happened at — a branch-restricted staff member at
 * Branch B would get paged for a table at Branch A that isn't theirs.
 * Mirrors the SSE realtime path's identical branch-scoping invariant
 * (src/db/__tests__/realtime-branch-filtering.test.ts), which was already
 * correct; this was the one delivery path that had never been updated to
 * match it.
 *
 * The fix adds an optional `branchId` param: when passed, only
 * subscriptions whose owner's CURRENT active grant is unrestricted
 * (branchId IS NULL — owner/manager/platform_admin) or scoped to that same
 * branch are notified. Since this send path always calls the real
 * `web-push` library, these tests exercise the actual DB query
 * `sendPushToRestaurant` builds (via VAPID left unconfigured, so the
 * function's own "not configured" early-return lets us assert on exactly
 * WHICH subscriptions it would have queried/attempted, without needing a
 * live push service) — the recipient-selection logic under test doesn't
 * depend on whether the send itself succeeds.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("sendPushToRestaurant branch filtering (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let push: typeof import("@/lib/push");
  let webpush: typeof import("web-push");

  let restaurantId: string;
  let branchAId: string;
  let branchBId: string;
  let unrestrictedOwnerId: string;
  let branchAStaffId: string;
  let branchBStaffId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    push = await import("@/lib/push");
    webpush = (await import("web-push")).default;

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-push-branch-${suffix}`, name: "TEST Push Branch Restaurant" })
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

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Push Owner", phone: `9741${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [staffA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Push Staff A", phone: `9742${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [staffB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Push Staff B", phone: `9743${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    unrestrictedOwnerId = owner.id;
    branchAStaffId = staffA.id;
    branchBStaffId = staffB.id;

    await db.insert(schema.userRoles).values([
      { userId: unrestrictedOwnerId, restaurantId, branchId: null, role: "owner" },
      { userId: branchAStaffId, restaurantId, branchId: branchAId, role: "waiter" },
      { userId: branchBStaffId, restaurantId, branchId: branchBId, role: "waiter" },
    ]);

    async function subscribe(userId: string, tag: string) {
      await db.insert(schema.pushSubscriptions).values({
        restaurantId,
        userId,
        endpoint: `https://push.example.test/${tag}-${suffix}`,
        p256dh: "test-p256dh",
        auth: "test-auth",
      });
    }
    await subscribe(unrestrictedOwnerId, "owner");
    await subscribe(branchAStaffId, "staff-a");
    await subscribe(branchBStaffId, "staff-b");
  });

  afterAll(async () => {
    await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, unrestrictedOwnerId));
    await db.delete(schema.users).where(eq(schema.users.id, branchAStaffId));
    await db.delete(schema.users).where(eq(schema.users.id, branchBStaffId));
  });

  it("a branch-scoped send reaches only the unrestricted owner and that branch's own staff", async () => {
    const sendSpy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as never);

    await push.sendPushToRestaurant(
      restaurantId,
      { title: "Table needs help", body: "Table 3 is calling staff", url: "/dashboard/tables" },
      branchAId,
    );

    const notifiedEndpoints = sendSpy.mock.calls.map((call) => (call[0] as { endpoint: string }).endpoint);
    expect(notifiedEndpoints.some((e) => e.includes("owner"))).toBe(true);
    expect(notifiedEndpoints.some((e) => e.includes("staff-a"))).toBe(true);
    // The whole point of the fix: Branch B's own staff must NOT be paged
    // for a Branch A event.
    expect(notifiedEndpoints.some((e) => e.includes("staff-b"))).toBe(false);

    sendSpy.mockRestore();
  });

  it("a send scoped to the OTHER branch reaches that branch's staff instead, still including the unrestricted owner", async () => {
    const sendSpy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as never);

    await push.sendPushToRestaurant(
      restaurantId,
      { title: "Table needs help", body: "Table 9 is calling staff", url: "/dashboard/tables" },
      branchBId,
    );

    const notifiedEndpoints = sendSpy.mock.calls.map((call) => (call[0] as { endpoint: string }).endpoint);
    expect(notifiedEndpoints.some((e) => e.includes("owner"))).toBe(true);
    expect(notifiedEndpoints.some((e) => e.includes("staff-b"))).toBe(true);
    expect(notifiedEndpoints.some((e) => e.includes("staff-a"))).toBe(false);

    sendSpy.mockRestore();
  });

  it("omitting branchId (restaurant-wide event) still reaches everyone, preserving prior behavior", async () => {
    const sendSpy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as never);

    await push.sendPushToRestaurant(restaurantId, {
      title: "Restaurant-wide notice",
      body: "No branch scope",
      url: "/dashboard",
    });

    const notifiedEndpoints = sendSpy.mock.calls.map((call) => (call[0] as { endpoint: string }).endpoint);
    expect(notifiedEndpoints.some((e) => e.includes("owner"))).toBe(true);
    expect(notifiedEndpoints.some((e) => e.includes("staff-a"))).toBe(true);
    expect(notifiedEndpoints.some((e) => e.includes("staff-b"))).toBe(true);

    sendSpy.mockRestore();
  });
});
