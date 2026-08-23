/**
 * RC audit P1 regression test: proves destroyOtherSessions()
 * (src/lib/auth/session.ts) — the function both the new change-password
 * route and the new logout-others route call — actually deletes every
 * OTHER session row for a user while leaving the caller's own session
 * (keepSessionId) and other users' sessions completely untouched.
 *
 * The two routes themselves resolve the caller's session via
 * requireAuth() -> getSession(), which reads an httpOnly cookie through
 * next/headers' cookies() — not callable outside an active Next.js
 * request context, so (same situation as every other CAS/route test in
 * this project with no session-mocking harness) this proves the function
 * the routes actually depend on directly, at the DB level.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("destroyOtherSessions (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let destroyOtherSessions: typeof import("@/lib/auth/session").destroyOtherSessions;

  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ({ destroyOtherSessions } = await import("@/lib/auth/session"));

    const suffix = Math.random().toString(36).slice(2, 8);
    const [userA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Destroy-Sessions User A", phone: `9791${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userAId = userA.id;

    const [userB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Destroy-Sessions User B", phone: `9792${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userBId = userB.id;
  });

  afterAll(async () => {
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userAId));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userBId));
    await db.delete(schema.users).where(eq(schema.users.id, userAId));
    await db.delete(schema.users).where(eq(schema.users.id, userBId));
  });

  // Each test creates its own sessions from a clean slate — without this,
  // a session left behind by one test (e.g. the intentionally-kept
  // keepSessionId) would count as a pre-existing "other" session in the
  // next test and skew its revoked-count assertion.
  afterEach(async () => {
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userAId));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userBId));
  });

  async function makeSession(userId: string) {
    const [row] = await db
      .insert(schema.sessions)
      .values({
        userId,
        tokenHash: Math.random().toString(36).slice(2),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.sessions.id });
    return row.id;
  }

  it("deletes every other session for the user, keeps the caller's own", async () => {
    const keepSessionId = await makeSession(userAId);
    const otherA = await makeSession(userAId);
    const otherB = await makeSession(userAId);

    const revoked = await destroyOtherSessions(userAId, keepSessionId);
    expect(revoked).toBe(2);

    const remaining = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userAId));
    expect(remaining.map((r) => r.id).sort()).toEqual([keepSessionId].sort());

    // Sanity: the deleted ids really are gone, not just excluded from the count.
    const stillThere = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, otherA));
    expect(stillThere).toHaveLength(0);
    const stillThereB = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, otherB));
    expect(stillThereB).toHaveLength(0);
  });

  it("never touches another user's sessions", async () => {
    const keepSessionId = await makeSession(userAId);
    const otherUserSession = await makeSession(userBId);

    await destroyOtherSessions(userAId, keepSessionId);

    const bSessions = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userBId));
    expect(bSessions.map((r) => r.id)).toContain(otherUserSession);
  });

  it("returns 0 and changes nothing when there are no other sessions", async () => {
    const keepSessionId = await makeSession(userAId);
    const revoked = await destroyOtherSessions(userAId, keepSessionId);
    expect(revoked).toBe(0);

    const remaining = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userAId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(keepSessionId);
  });
});
