/**
 * Gap-audit P1 — email-provider-failure resilience (src/lib/email.ts).
 *
 * Same reasoning as the two push-*-fallback/push-service-down integration
 * tests alongside this file: there is no real Resend account to fail on
 * demand in this sandbox, and genuinely knocking out a real email provider
 * from inside a Playwright E2E run isn't practically testable without
 * mocking that would defeat the point of an E2E test. This is instead an
 * INTEGRATION test — a real Postgres DB (for the real owner-email lookup
 * every sendFallbackAlertEmail call goes through), the real
 * `sendFallbackAlertEmail`/`sendTransactionalEmail` functions, with only
 * the actual external network boundary (the `fetch` call to Resend's HTTP
 * API) mocked.
 *
 * Proves the documented contract in email.ts's own doc comments: every
 * send in this file is "best-effort and fire-and-forget from the caller's
 * perspective... must never throw or delay" whatever it's reporting on. A
 * real Resend outage (network failure, a 5xx, an invalid API key rejected
 * with 401) must degrade to "no email sent, logged," never an unhandled
 * rejection surfacing elsewhere (an order write, a password reset
 * request).
 *
 * Each sendFallbackAlertEmail case seeds its OWN restaurant/owner —
 * sendFallbackAlertEmail rate-limits itself to one send per 10 minutes per
 * restaurantId (see its own doc comment), so reusing one restaurant across
 * these cases would make every call after the first a no-op regardless of
 * what's being tested.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as every other
 * DB-backed integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { sendFallbackAlertEmail, sendTransactionalEmail } from "@/lib/email";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("email.ts — Resend provider failure resilience (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  const createdRestaurantIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env.RESEND_API_KEY = "test-resend-key";
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
  });

  afterAll(async () => {
    for (const restaurantId of createdRestaurantIds) {
      await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    }
    for (const userId of createdUserIds) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** One fresh restaurant + active owner (with a real email on file) per
   * call — see the file header comment for why sendFallbackAlertEmail's
   * own rate limit requires this instead of one shared fixture. */
  async function seedRestaurantWithOwner(): Promise<{ restaurantId: string; ownerEmail: string }> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const ownerEmail = `test-email-failure-${suffix}@example.test`;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-email-failure-${suffix}`, name: "TEST Email Failure Restaurant" })
      .returning({ id: schema.restaurants.id });
    createdRestaurantIds.push(restaurant.id);

    const [owner] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Email Failure Owner",
        phone: `9746${suffix.slice(0, 6)}`,
        passwordHash: "x",
        email: ownerEmail,
      })
      .returning({ id: schema.users.id });
    createdUserIds.push(owner.id);

    await db.insert(schema.userRoles).values({
      userId: owner.id,
      restaurantId: restaurant.id,
      branchId: null,
      role: "owner",
    });

    return { restaurantId: restaurant.id, ownerEmail };
  }

  it("a network failure reaching Resend (fetch throws) never throws back to the caller", async () => {
    const { restaurantId } = await seedRestaurantWithOwner();
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("ENETUNREACH — network is unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendFallbackAlertEmail(restaurantId, "New order", "Table 3 placed an order"),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("a 5xx from Resend (provider outage) never throws back to the caller", async () => {
    const { restaurantId } = await seedRestaurantWithOwner();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("Internal Server Error", { status: 503 }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendFallbackAlertEmail(restaurantId, "Table calling", "Table 5 needs help"),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("email.ts: Resend API returned", 503, expect.any(String));
  });

  it("sendTransactionalEmail (the forgot-password send path) surfaces a provider failure as `false`, never a thrown/rejected error", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await sendTransactionalEmail(
      "someone@example.test",
      "Reset your password",
      "Here's your reset link...",
    );
    expect(ok).toBe(false);
  });

  it("contrast case — a healthy Resend response actually reaches the owner's real email with the right content", async () => {
    const { restaurantId, ownerEmail } = await seedRestaurantWithOwner();
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await sendFallbackAlertEmail(restaurantId, "New order", "Table 3 placed an order");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toBe(ownerEmail);
    expect(body.subject).toBe("New order");
    expect(body.text).toContain("Table 3 placed an order");
  });
});
