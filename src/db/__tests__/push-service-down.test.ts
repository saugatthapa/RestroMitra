/**
 * Gap-audit P1 — push-notification-failure resilience, part 2 of 2 (see
 * push-not-configured-fallback.test.ts's header comment for why this is
 * split into its own file, and why that's the right way to work with
 * push.ts's module-scoped VAPID-configured memoization under Vitest's
 * default per-file isolation).
 *
 * Here VAPID IS configured (with a real, freshly-generated keypair —
 * `web-push`'s own setVapidDetails() only validates key FORMAT, a local,
 * synchronous check; it never makes a network call, so this needs no real
 * push service to set up) and covers what happens once push is nominally
 * live:
 *
 *   - Zero subscriptions despite being configured -> still falls back to
 *     email (the other documented "nobody to push to" case).
 *   - The push SERVICE itself is down (every send throws, e.g. a network
 *     blip / 5xx) -> the caller must never fail because of it, and — per
 *     the documented contract — the email fallback is deliberately NOT
 *     attempted here (only the two "nobody to push to" cases above are),
 *     since a transient failure may well succeed next time; the still-good
 *     subscription is left alone, not mistaken for a dead one.
 *   - A 404/410 from the push service (a subscription that's genuinely
 *     gone — uninstalled, permission revoked) -> that ONE subscription is
 *     deleted so the list doesn't grow stale forever, without touching a
 *     different, still-live subscription for the same restaurant.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as every other
 * DB-backed integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import webpush from "web-push";
import { sendPushToRestaurant } from "@/lib/push";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("sendPushToRestaurant — VAPID configured, push service failures (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let branchId: string;
  let ownerId: string;

  beforeAll(async () => {
    // A real, validly-formatted VAPID keypair — generated locally, no
    // network call — so ensureConfigured()'s setVapidDetails() actually
    // succeeds and every test below exercises the CONFIGURED code path,
    // not the "not configured" early return covered by the sibling file.
    const vapid = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    process.env.VAPID_SUBJECT = "mailto:test@example.test";
    process.env.RESEND_API_KEY = "test-resend-key";

    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-push-down-${suffix}`, name: "TEST Push Down Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [owner] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Push Down Owner",
        phone: `9745${suffix.slice(0, 6)}`,
        passwordHash: "x",
        email: `test-push-down-${suffix}@example.test`,
      })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    await db.insert(schema.userRoles).values({ userId: ownerId, restaurantId, branchId, role: "owner" });
  });

  afterAll(async () => {
    await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to emailing the owner when push IS configured but there are zero live subscriptions", async () => {
    const sendSpy = vi.spyOn(webpush, "sendNotification");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await sendPushToRestaurant(restaurantId, {
      title: "Table calling",
      body: "Table 5 needs help",
      url: "/dashboard/tables",
    });

    expect(sendSpy).not.toHaveBeenCalled(); // nothing to send to
    // Fire-and-forget fallback (see the sibling "not configured" test's
    // comment on vi.waitFor here) — the real DB owner-email lookup inside
    // it hasn't necessarily resolved the instant sendPushToRestaurant's
    // own await returns.
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("a down push service (every send throws) never fails the caller, and does NOT fall back to email", async () => {
    const [sub] = await db
      .insert(schema.pushSubscriptions)
      .values({
        restaurantId,
        userId: ownerId,
        endpoint: `https://push.example.test/down-service-${Math.random()}`,
        p256dh: "test-p256dh",
        auth: "test-auth",
      })
      .returning({ id: schema.pushSubscriptions.id });

    const sendSpy = vi
      .spyOn(webpush, "sendNotification")
      .mockRejectedValue(Object.assign(new Error("ECONNREFUSED — push service unreachable"), { statusCode: undefined }));
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The whole point: this must resolve cleanly, not throw/reject — the
    // real caller (order/service-call creation) invokes this with `void`
    // and has no error boundary of its own for it.
    await expect(
      sendPushToRestaurant(restaurantId, {
        title: "New order",
        body: "Table 3 placed an order",
        url: "/dashboard/orders",
      }),
    ).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    // Deliberately NOT a fallback case — a subscription genuinely exists,
    // this is just a transient failure to actually reach it.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    // The still-broken (non-404/410) subscription is left alone — a
    // transient failure must not be treated as "this subscription is
    // gone" and deleted.
    const remaining = await db
      .select({ id: schema.pushSubscriptions.id })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.id, sub.id));
    expect(remaining).toHaveLength(1);

    await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
  });

  it("a 404/410 from the push service (subscription genuinely gone) deletes only that stale subscription", async () => {
    const [staleSub] = await db
      .insert(schema.pushSubscriptions)
      .values({
        restaurantId,
        userId: ownerId,
        endpoint: `https://push.example.test/stale-${Math.random()}`,
        p256dh: "test-p256dh",
        auth: "test-auth",
      })
      .returning({ id: schema.pushSubscriptions.id });
    const [liveSub] = await db
      .insert(schema.pushSubscriptions)
      .values({
        restaurantId,
        userId: ownerId,
        endpoint: `https://push.example.test/live-${Math.random()}`,
        p256dh: "test-p256dh",
        auth: "test-auth",
      })
      .returning({ id: schema.pushSubscriptions.id });

    vi.spyOn(webpush, "sendNotification").mockImplementation(async (sub) => {
      if ((sub as { endpoint: string }).endpoint.includes("stale")) {
        throw Object.assign(new Error("Gone"), { statusCode: 410 });
      }
      return {} as never;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await sendPushToRestaurant(restaurantId, {
      title: "New order",
      body: "Table 3 placed an order",
      url: "/dashboard/orders",
    });

    const remaining = await db
      .select({ id: schema.pushSubscriptions.id })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.restaurantId, restaurantId));
    const remainingIds = remaining.map((row) => row.id);
    expect(remainingIds).not.toContain(staleSub.id);
    expect(remainingIds).toContain(liveSub.id);

    await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, liveSub.id));
  });
});
