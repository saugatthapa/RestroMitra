/**
 * Commercial-launch Phase B.3 (Forgot Password) integration tests for
 * src/lib/auth/password-reset.ts's createPasswordResetToken/
 * redeemPasswordResetToken — the security-sensitive core of the reset
 * flow (single-use, short-lived, CAS-claimed tokens).
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Password reset tokens (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let passwordReset: typeof import("@/lib/auth/password-reset");
  let sessionLib: typeof import("@/lib/auth/session");
  let hashPassword: typeof import("@/lib/auth/password").hashPassword;
  let verifyPassword: typeof import("@/lib/auth/password").verifyPassword;

  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    passwordReset = await import("@/lib/auth/password-reset");
    sessionLib = await import("@/lib/auth/session");
    ({ hashPassword, verifyPassword } = await import("@/lib/auth/password"));

    const suffix = Math.random().toString(36).slice(2, 8);

    const [user] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Password Reset User",
        phone: `978${suffix}`,
        email: `reset-${suffix}@example.com`,
        passwordHash: await hashPassword("OriginalPass1"),
      })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [otherUser] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Other User",
        phone: `979${suffix}`,
        email: `other-${suffix}@example.com`,
        passwordHash: await hashPassword("OriginalPass1"),
      })
      .returning({ id: schema.users.id });
    otherUserId = otherUser.id;
  });

  afterAll(async () => {
    await db.delete(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.userId, userId));
    await db.delete(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.userId, otherUserId));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, otherUserId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
  });

  it("happy path: a freshly issued token redeems successfully and updates the password", async () => {
    const token = await passwordReset.createPasswordResetToken(userId, "1.2.3.4");
    const newHash = await hashPassword("BrandNewPass2");

    const result = await passwordReset.redeemPasswordResetToken(token, newHash);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(userId);

    const [row] = await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, userId));
    expect(await verifyPassword("BrandNewPass2", row.passwordHash)).toBe(true);
  });

  it("duplicate request: the same token cannot be redeemed a second time", async () => {
    const token = await passwordReset.createPasswordResetToken(userId, null);
    const firstHash = await hashPassword("FirstPass123");
    const secondHash = await hashPassword("SecondPass123");

    const first = await passwordReset.redeemPasswordResetToken(token, firstHash);
    expect(first).not.toBeNull();

    const second = await passwordReset.redeemPasswordResetToken(token, secondHash);
    expect(second).toBeNull();

    // The password from the (successful) first redemption sticks — the
    // second, rejected attempt must not have overwritten it.
    const [row] = await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, userId));
    expect(await verifyPassword("FirstPass123", row.passwordHash)).toBe(true);
    expect(await verifyPassword("SecondPass123", row.passwordHash)).toBe(false);
  });

  it("concurrent request: two simultaneous redemptions of the same token — exactly one succeeds", async () => {
    const token = await passwordReset.createPasswordResetToken(userId, null);
    const hashA = await hashPassword("ConcurrentA123");
    const hashB = await hashPassword("ConcurrentB123");

    const [a, b] = await Promise.all([
      passwordReset.redeemPasswordResetToken(token, hashA),
      passwordReset.redeemPasswordResetToken(token, hashB),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o !== null)).toHaveLength(1);
    expect(outcomes.filter((o) => o === null)).toHaveLength(1);
  });

  it("edge case: an expired token is rejected even though it was never used", async () => {
    // Insert an already-expired token row directly (createPasswordResetToken
    // always issues a fresh 30-min-out token, so this bypasses it to
    // simulate the passage of time).
    const { createHash, randomBytes } = await import("crypto");
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(schema.passwordResetTokens).values({
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() - 60_000), // 1 minute in the past
    });

    const result = await passwordReset.redeemPasswordResetToken(rawToken, await hashPassword("Whatever123"));
    expect(result).toBeNull();
  });

  it("validation failure: a garbage/nonexistent token is rejected", async () => {
    const result = await passwordReset.redeemPasswordResetToken("not-a-real-token", await hashPassword("Whatever123"));
    expect(result).toBeNull();
  });

  it("wrong-user isolation: redeeming user A's token never touches user B's password", async () => {
    const originalOtherHashRow = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, otherUserId));
    const originalOtherHash = originalOtherHashRow[0].passwordHash;

    const token = await passwordReset.createPasswordResetToken(userId, null);
    await passwordReset.redeemPasswordResetToken(token, await hashPassword("OnlyForUserA1"));

    const [otherRow] = await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, otherUserId));
    expect(otherRow.passwordHash).toBe(originalOtherHash);
  });

  it("requesting a new token invalidates the previous unused one", async () => {
    const firstToken = await passwordReset.createPasswordResetToken(userId, null);
    const secondToken = await passwordReset.createPasswordResetToken(userId, null);
    expect(secondToken).not.toBe(firstToken);

    // The first token is now retired — it must fail even though it was
    // never itself redeemed, and even though it hasn't expired yet.
    const firstAttempt = await passwordReset.redeemPasswordResetToken(firstToken, await hashPassword("Whatever123"));
    expect(firstAttempt).toBeNull();

    // The second (current) token still works.
    const secondAttempt = await passwordReset.redeemPasswordResetToken(secondToken, await hashPassword("StillWorks123"));
    expect(secondAttempt).not.toBeNull();
  });

  it("rollback/failure: redemption alone leaves existing sessions untouched; the route's own destroyAllSessions call is what clears them", async () => {
    // redeemPasswordResetToken only claims the token + writes the new
    // password hash — it's the CALLER (reset-password/route.ts) that
    // separately invokes destroyAllSessions afterward. Verifying that
    // composition here: insert two live sessions, redeem successfully,
    // confirm both sessions are STILL there (redemption itself doesn't
    // touch them), then confirm destroyAllSessions actually clears both,
    // exactly as the route does right after a successful redemption.
    await db.insert(schema.sessions).values({
      userId,
      tokenHash: `test-fixture-session-hash-1-${userId}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await db.insert(schema.sessions).values({
      userId,
      tokenHash: `test-fixture-session-hash-2-${userId}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const token = await passwordReset.createPasswordResetToken(userId, null);
    const result = await passwordReset.redeemPasswordResetToken(token, await hashPassword("PostResetPass1"));
    expect(result).not.toBeNull();

    const stillThere = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
    expect(stillThere).toHaveLength(2);

    const revoked = await sessionLib.destroyAllSessions(userId);
    expect(revoked).toBe(2);

    const afterRevoke = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
    expect(afterRevoke).toHaveLength(0);
  });
});
