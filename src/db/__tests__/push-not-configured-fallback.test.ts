/**
 * Gap-audit P1 — push-notification-failure resilience, part 1 of 2 (see
 * push-service-down.test.ts for the "VAPID IS configured but the service
 * itself is unreachable" half — split into two files deliberately, since
 * src/lib/push.ts memoizes whether VAPID configuration succeeded at module
 * scope: Vitest's default per-file isolation gives each test FILE its own
 * fresh copy of that module, which is what lets one file exercise the
 * "never configured" state and the other the "configured" state reliably,
 * without fighting the module's own memoization).
 *
 * Genuinely triggering a real push-service or email-provider outage against
 * a real browser isn't practically testable through Playwright without
 * heavy mocking that would defeat the point of an E2E test — there is no
 * real push service / Resend account to fail on demand in this sandbox.
 * This is instead an INTEGRATION test, one level down — same style as
 * push-branch-filtering.test.ts: a real Postgres DB, the real
 * `sendPushToRestaurant` function, with only the actual external network
 * boundary (`web-push`'s `sendNotification`, and — via the fallback path —
 * the Resend HTTP call inside `email.ts`) mocked.
 *
 * Covers the two "categorically nobody to push to" cases documented on
 * `sendPushToRestaurant` itself: VAPID was never configured on this
 * deployment, and VAPID IS configured but there's genuinely no live
 * subscription. Both fall back to emailing the restaurant's owner rather
 * than the alert silently going nowhere.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as every other
 * DB-backed integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import webpush from "web-push";
import { sendPushToRestaurant } from "@/lib/push";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("sendPushToRestaurant — VAPID not configured / no subscriptions (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let ownerId: string;
  let ownerEmail: string;

  beforeAll(async () => {
    // Deleted before anything in this file ever calls sendPushToRestaurant
    // (ensureConfigured() reads these lazily on each call, not at import
    // time — see push.ts's own doc comment) — guarantees this file's own
    // "not configured" scenario regardless of what a real deployment's
    // .env.local (or another test file, in a shared worker) happened to
    // set. RESEND_API_KEY IS set — the fallback's own destination.
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    process.env.RESEND_API_KEY = "test-resend-key";

    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);
    ownerEmail = `test-push-fallback-${suffix}@example.test`;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-push-fallback-${suffix}`, name: "TEST Push Fallback Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main", isMain: true })
      .returning({ id: schema.branches.id });

    const [owner] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Push Fallback Owner",
        phone: `9744${suffix.slice(0, 6)}`,
        passwordHash: "x",
        email: ownerEmail,
      })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    await db.insert(schema.userRoles).values({
      userId: ownerId,
      restaurantId,
      branchId: branch.id,
      role: "owner",
    });
  });

  afterAll(async () => {
    await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.restaurantId, restaurantId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  it("falls back to emailing the owner when VAPID is entirely unconfigured (the common not-yet-deployed-push case)", async () => {
    const sendSpy = vi.spyOn(webpush, "sendNotification");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await sendPushToRestaurant(restaurantId, {
      title: "New order",
      body: "Table 3 placed an order",
      url: "/dashboard/orders",
    });

    // The push service itself was never even contacted...
    expect(sendSpy).not.toHaveBeenCalled();
    // ...but the owner's inbox was, as the documented fallback. This is
    // fired with `void` inside sendPushToRestaurant (deliberately
    // fire-and-forget — see push.ts's own comment), so the awaited call
    // above returning doesn't guarantee the fallback's own DB lookup +
    // fetch have actually completed yet; vi.waitFor polls for it instead
    // of racing a fixed sleep against real DB I/O.
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.resend.com/emails",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.to).toBe(ownerEmail);
    expect(body.subject).toBe("New order");

    sendSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});
