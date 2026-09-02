/**
 * QA hardening (P2 backlog, RESTROMITRA_MASTER_GAP_AUDIT.md): "General
 * platform-admin list/read endpoints ... have no rate limiting of their
 * own." This exercises the REAL GET /api/admin/audit-log route handler
 * (not a reimplementation) and proves it now enforces the shared
 * `admin-read:user:<id>` bucket (120 requests / 60s — see the route's own
 * comment) added to close that gap, following the same "call the real
 * exported route handler with a real Request" pattern as
 * src/app/api/order/[token]/route.test.ts.
 *
 * requirePlatformPermission and listPlatformAuditLogs are mocked (vi.mock,
 * same pattern as src/lib/api-route-helpers.test.ts) rather than exercised
 * against a real DB-backed session — this test is about the rate-limit
 * backstop the route now has, not the auth gate in front of it (already
 * covered by src/db/__tests__/platform-authorization.test.ts) or the audit
 * log query itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requirePlatformPermission = vi.fn();
vi.mock("@/lib/rbac/guard", () => ({
  requirePlatformPermission: (...args: unknown[]) => requirePlatformPermission(...args),
}));

const listPlatformAuditLogs = vi.fn();
vi.mock("@/lib/audit", () => ({
  listPlatformAuditLogs: (...args: unknown[]) => listPlatformAuditLogs(...args),
}));

function sessionFor(userId: string) {
  return {
    sessionId: "test-session-id",
    user: { id: userId, fullName: "TEST Admin", phone: "9770000001", email: null },
    activeRestaurantId: null,
  };
}

describe("GET /api/admin/audit-log rate limiting", () => {
  beforeEach(() => {
    requirePlatformPermission.mockReset();
    listPlatformAuditLogs.mockReset();
    listPlatformAuditLogs.mockResolvedValue({ logs: [], total: 0 });
  });

  // Kept as a single test (rather than split across separate `it` blocks)
  // so there's no risk of one test's async work bleeding into the next via
  // the shared requirePlatformPermission mock — see the loop's 120 awaited
  // calls below, which a slow, loaded CI/full-suite run can otherwise push
  // past vitest's default 5s per-test timeout even though real work here is
  // just mocked promises (hence the explicit longer timeout).
  it(
    "allows exactly 120 requests per admin in the window, 429s the 121st, and keys the bucket per admin",
    async () => {
      requirePlatformPermission.mockResolvedValue(sessionFor("test-admin-rl-user-1"));
      const { GET } = await import("./route");

      for (let i = 0; i < 120; i++) {
        const res = await GET(new Request("http://localhost:3100/api/admin/audit-log"));
        expect(res.status).toBe(200);
      }
      expect(listPlatformAuditLogs).toHaveBeenCalledTimes(120);

      const limited = await GET(new Request("http://localhost:3100/api/admin/audit-log"));
      expect(limited.status).toBe(429);
      const body = await limited.json();
      expect(body.error).toBe("Too many requests. Please wait a moment.");

      // The DB is never even queried once the bucket is exhausted — the
      // rate-limit check runs before any query.
      expect(listPlatformAuditLogs).toHaveBeenCalledTimes(120);

      // A DIFFERENT admin has their own independent bucket — the exhausted
      // admin above never blocks anyone else.
      requirePlatformPermission.mockResolvedValue(sessionFor("test-admin-rl-user-2"));
      const otherAdmin = await GET(new Request("http://localhost:3100/api/admin/audit-log"));
      expect(otherAdmin.status).toBe(200);
    },
    30_000,
  );
});
