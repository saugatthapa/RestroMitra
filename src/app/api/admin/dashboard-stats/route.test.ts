/**
 * Gap-audit P1 fix (Finding 1) — integration test for the REAL exported
 * GET handler (not a reimplementation), proving both the data it returns
 * AND that it's properly authorization-gated.
 *
 * Every other DB-integration test in this project that touches an
 * authenticated route notes there's "no session-mocking harness" for API
 * route handlers (see destroy-other-sessions.test.ts, plan-limit-race-
 * db.test.ts) because getSession() reads its cookie via next/headers'
 * cookies(), which isn't callable outside an active Next.js request
 * context. This file builds that harness: next/headers is mocked so
 * cookies() resolves a REAL session row this test inserts directly into
 * the DB (via a real token/tokenHash pair, exactly what createSession()
 * itself would produce), letting requirePlatformPermission() run its real,
 * unmocked, DB-backed authorization logic against a real caller identity —
 * only the cookie transport is faked, not the authorization decision.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same convention as
 * every other DB-backed integration test in this project.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import crypto from "node:crypto";

const hasDb = Boolean(process.env.DATABASE_URL);

let currentToken: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => {
    const { SESSION_COOKIE_NAME } = await import("@/lib/auth/session-cookie");
    return {
      get: (name: string) => (name === SESSION_COOKIE_NAME && currentToken ? { value: currentToken } : undefined),
    };
  },
}));

describe.skipIf(!hasDb)("GET /api/admin/dashboard-stats (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let GET: typeof import("./route").GET;

  let plainUserId: string;
  let plainUserToken: string;
  let viewerUserId: string;
  let viewerToken: string;
  const suffix = Math.random().toString(36).slice(2, 8);

  function hashToken(token: string) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  async function createTestSession(userId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString("base64url");
    await db.insert(schema.sessions).values({
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return token;
  }

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ({ GET } = await import("./route"));

    const [plainUser] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Dashboard Stats Plain User",
        phone: `9796${suffix.slice(0, 6)}`,
        passwordHash: "x",
        mfaEnabled: true,
      })
      .returning({ id: schema.users.id });
    plainUserId = plainUser.id;
    plainUserToken = await createTestSession(plainUserId);

    const [viewerUser] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Dashboard Stats Viewer",
        phone: `9797${suffix.slice(0, 6)}`,
        passwordHash: "x",
        mfaEnabled: true,
      })
      .returning({ id: schema.users.id });
    viewerUserId = viewerUser.id;
    viewerToken = await createTestSession(viewerUserId);
    await db.insert(schema.userRoles).values({
      userId: viewerUserId,
      restaurantId: null,
      role: "platform_viewer",
    });
  });

  afterAll(async () => {
    const userIds = [plainUserId, viewerUserId];
    await db.delete(schema.userRoles).where(inArray(schema.userRoles.userId, userIds));
    await db.delete(schema.sessions).where(inArray(schema.sessions.userId, userIds));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  });

  it("rejects an unauthenticated request with 401", async () => {
    currentToken = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("rejects an authenticated user with no platform role with 403", async () => {
    currentToken = plainUserToken;
    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/platform permission/i);
  });

  it("allows a platform_viewer (VIEW_TENANTS) and returns real metrics + recent activity", async () => {
    currentToken = viewerToken;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.metrics.users.total).toBe("number");
    expect(typeof body.metrics.users.active).toBe("number");
    expect(typeof body.metrics.branches.total).toBe("number");
    expect(typeof body.metrics.orders.today).toBe("number");
    expect(typeof body.metrics.orders.thisMonth).toBe("number");
    expect(typeof body.metrics.revenue.activeMonthlyInPaisa).toBe("number");
    expect(Array.isArray(body.metrics.planDistribution)).toBe(true);
    expect(Array.isArray(body.metrics.featureUsage)).toBe(true);
    expect(Array.isArray(body.recentActivity)).toBe(true);
    // Our own platform-role grant above is itself an audited action —
    // sanity check the metrics reflect the user we just created existing.
    expect(body.metrics.users.total).toBeGreaterThanOrEqual(1);
  });

  afterAll(() => {
    currentToken = null;
  });
});
