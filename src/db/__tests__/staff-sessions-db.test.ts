/**
 * Gap-audit P1 fix (Finding 2) — integration test for
 * listActiveSessionsForUser() / destroySessionById() (src/lib/auth/
 * session.ts), which back the platform admin console's real per-session
 * active-sessions list and individual-session revoke, replacing the
 * previous blind "revoke everything."
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same convention as
 * destroy-other-sessions.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("listActiveSessionsForUser / destroySessionById (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let sessionLib: typeof import("@/lib/auth/session");

  let userAId: string;
  let userBId: string;
  const suffix = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    sessionLib = await import("@/lib/auth/session");

    const [userA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Staff Sessions User A", phone: `9793${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userAId = userA.id;

    const [userB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Staff Sessions User B", phone: `9794${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userBId = userB.id;
  });

  afterAll(async () => {
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userAId));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userBId));
    await db.delete(schema.users).where(eq(schema.users.id, userAId));
    await db.delete(schema.users).where(eq(schema.users.id, userBId));
  });

  afterEach(async () => {
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userAId));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userBId));
  });

  async function makeSession(
    userId: string,
    opts: { expired?: boolean; userAgent?: string; ipAddress?: string } = {},
  ) {
    const [row] = await db
      .insert(schema.sessions)
      .values({
        userId,
        tokenHash: Math.random().toString(36).slice(2),
        userAgent: opts.userAgent ?? "TEST-Agent/1.0",
        ipAddress: opts.ipAddress ?? "203.0.113.1",
        expiresAt: opts.expired
          ? new Date(Date.now() - 60_000)
          : new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.sessions.id });
    return row.id;
  }

  it("lists device/IP/created/expires for every unexpired session, newest first", async () => {
    const older = await makeSession(userAId, { userAgent: "Chrome/1", ipAddress: "10.0.0.1" });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await makeSession(userAId, { userAgent: "Safari/2", ipAddress: "10.0.0.2" });

    const sessions = await sessionLib.listActiveSessionsForUser(userAId);
    expect(sessions.map((s) => s.id)).toEqual([newer, older]);
    expect(sessions[0].userAgent).toBe("Safari/2");
    expect(sessions[0].ipAddress).toBe("10.0.0.2");
    expect(sessions[0].createdAt).toBeInstanceOf(Date);
    expect(sessions[0].expiresAt).toBeInstanceOf(Date);
  });

  it("excludes an already-expired session", async () => {
    await makeSession(userAId, { expired: true });
    const active = await makeSession(userAId);

    const sessions = await sessionLib.listActiveSessionsForUser(userAId);
    expect(sessions.map((s) => s.id)).toEqual([active]);
  });

  it("never lists another user's sessions", async () => {
    await makeSession(userAId);
    await makeSession(userBId);

    const aSessions = await sessionLib.listActiveSessionsForUser(userAId);
    expect(aSessions).toHaveLength(1);
  });

  it("destroySessionById revokes exactly the one session and returns true", async () => {
    const keep = await makeSession(userAId);
    const toRevoke = await makeSession(userAId);

    const revoked = await sessionLib.destroySessionById(toRevoke, userAId);
    expect(revoked).toBe(true);

    const remaining = await sessionLib.listActiveSessionsForUser(userAId);
    expect(remaining.map((s) => s.id)).toEqual([keep]);
  });

  it("destroySessionById returns false and changes nothing for a session id that doesn't belong to that user", async () => {
    const otherUsersSession = await makeSession(userBId);

    const revoked = await sessionLib.destroySessionById(otherUsersSession, userAId);
    expect(revoked).toBe(false);

    const stillThere = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, otherUsersSession));
    expect(stillThere).toHaveLength(1);
  });

  it("destroySessionById returns false for an id that doesn't exist at all", async () => {
    const revoked = await sessionLib.destroySessionById("00000000-0000-0000-0000-000000000000", userAId);
    expect(revoked).toBe(false);
  });
});
