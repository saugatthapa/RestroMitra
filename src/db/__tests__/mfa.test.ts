/**
 * Commercial-launch Phase B.4 (MFA) integration tests for
 * src/lib/auth/mfa.ts — TOTP enrollment/confirmation, login-challenge
 * verification (both by live code and backup code), anti-replay
 * protection, and disable/regenerate.
 *
 * Uses otplib's own `generate()` directly to produce live codes against a
 * known secret, exactly the way a real authenticator app would, rather
 * than hand-computing HMAC values.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { generate } from "otplib";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("MFA (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let mfa: typeof import("@/lib/auth/mfa");
  let hashPassword: typeof import("@/lib/auth/password").hashPassword;

  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    mfa = await import("@/lib/auth/mfa");
    ({ hashPassword } = await import("@/lib/auth/password"));

    const suffix = Math.random().toString(36).slice(2, 8);

    const [user] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST MFA User",
        phone: `971${suffix}`,
        passwordHash: await hashPassword("OriginalPass1"),
      })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [otherUser] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST MFA Other User",
        phone: `972${suffix}`,
        passwordHash: await hashPassword("OriginalPass1"),
      })
      .returning({ id: schema.users.id });
    otherUserId = otherUser.id;
  });

  afterAll(async () => {
    await db.delete(schema.mfaBackupCodes).where(eq(schema.mfaBackupCodes.userId, userId));
    await db.delete(schema.mfaBackupCodes).where(eq(schema.mfaBackupCodes.userId, otherUserId));
    await db.delete(schema.mfaChallenges).where(eq(schema.mfaChallenges.userId, userId));
    await db.delete(schema.mfaChallenges).where(eq(schema.mfaChallenges.userId, otherUserId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
  });

  // Enrollment's own confirmation code is verified (and its time step
  // recorded as mfaLastUsedTimeStep) exactly like a login code — so if
  // this helper generated its code for the CURRENT time step, every test
  // that immediately generates "the current code" afterward would race
  // enrollment for that same time step and get correctly rejected as a
  // replay (this is real, working anti-replay behavior, not a test bug —
  // it just means the fixture needs to leave the current time step free).
  // Generating the enrollment code one step (30s) in the PAST stays inside
  // verify's ±1-step epochTolerance (so enrollment still succeeds) while
  // leaving the current and future time steps free for the rest of the
  // test to use.
  async function enroll(targetUserId: string) {
    const { secret } = mfa.generateMfaEnrollment(`test-${targetUserId}@example.com`);
    const pastEpoch = Math.floor(Date.now() / 1000) - 30;
    const code = await generate({ secret, period: 30, epoch: pastEpoch });
    const result = await mfa.confirmMfaEnrollment(targetUserId, secret, code);
    if (!result.ok) throw new Error("enrollment confirm unexpectedly failed in test setup");
    return { secret, backupCodes: result.backupCodes };
  }

  it("happy path: enrollment confirms with a valid live code and issues 10 backup codes", async () => {
    const { secret, backupCodes } = await enroll(userId);
    expect(secret).toBeTruthy();
    expect(backupCodes).toHaveLength(10);
    // All codes distinct.
    expect(new Set(backupCodes).size).toBe(10);

    const [row] = await db
      .select({ mfaEnabled: schema.users.mfaEnabled, mfaSecret: schema.users.mfaSecret })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(row.mfaEnabled).toBe(true);
    expect(row.mfaSecret).toBe(secret);

    // Reset for the next test.
    await mfa.disableMfa(userId);
  });

  it("validation failure: confirming enrollment with a wrong code never enables MFA", async () => {
    const { secret } = mfa.generateMfaEnrollment(`test-${userId}@example.com`);
    const result = await mfa.confirmMfaEnrollment(userId, secret, "000000");
    expect(result.ok).toBe(false);

    const [row] = await db.select({ mfaEnabled: schema.users.mfaEnabled }).from(schema.users).where(eq(schema.users.id, userId));
    expect(row.mfaEnabled).toBe(false);
  });

  it("happy path: a login challenge verifies successfully with a fresh live TOTP code", async () => {
    const { secret } = await enroll(userId);
    const challengeToken = await mfa.createMfaChallenge(userId, "1.2.3.4", "test-agent");
    const challenge = await mfa.getMfaChallenge(challengeToken);
    expect(challenge).not.toBeNull();

    const code = await generate({ secret, period: 30 });
    const ok = await mfa.verifyMfaChallengeWithTotp(challenge!.id, userId, code);
    expect(ok).toBe(true);

    // The challenge is now consumed — a second lookup must fail.
    const reused = await mfa.getMfaChallenge(challengeToken);
    expect(reused).toBeNull();

    await mfa.disableMfa(userId);
  });

  it("duplicate request / anti-replay: the exact same code cannot verify a second (fresh) challenge", async () => {
    const { secret } = await enroll(userId);
    const code = await generate({ secret, period: 30 });

    const tokenA = await mfa.createMfaChallenge(userId, null, null);
    const challengeA = await mfa.getMfaChallenge(tokenA);
    const firstOk = await mfa.verifyMfaChallengeWithTotp(challengeA!.id, userId, code);
    expect(firstOk).toBe(true);

    // A brand new challenge, but the SAME already-used code — must be
    // rejected by afterTimeStep-based replay protection even though this
    // is technically a different challenge row.
    const tokenB = await mfa.createMfaChallenge(userId, null, null);
    const challengeB = await mfa.getMfaChallenge(tokenB);
    const secondOk = await mfa.verifyMfaChallengeWithTotp(challengeB!.id, userId, code);
    expect(secondOk).toBe(false);

    // The second (rejected) challenge stays unconsumed/live — the user can
    // retry it with a genuinely new code.
    const stillLive = await mfa.getMfaChallenge(tokenB);
    expect(stillLive).not.toBeNull();

    await mfa.disableMfa(userId);
  });

  it("concurrent request: two simultaneous verifications of the same challenge — exactly one succeeds", async () => {
    const { secret } = await enroll(userId);
    const code = await generate({ secret, period: 30 });
    const token = await mfa.createMfaChallenge(userId, null, null);
    const challenge = await mfa.getMfaChallenge(token);

    const [a, b] = await Promise.all([
      mfa.verifyMfaChallengeWithTotp(challenge!.id, userId, code),
      mfa.verifyMfaChallengeWithTotp(challenge!.id, userId, code),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(outcomes.filter((o) => !o)).toHaveLength(1);

    await mfa.disableMfa(userId);
  });

  it("wrong code: an invalid code fails and leaves the challenge live for a retry", async () => {
    const { secret } = await enroll(userId);
    const token = await mfa.createMfaChallenge(userId, null, null);
    const challenge = await mfa.getMfaChallenge(token);

    const ok = await mfa.verifyMfaChallengeWithTotp(challenge!.id, userId, "111111");
    expect(ok).toBe(false);

    const stillLive = await mfa.getMfaChallenge(token);
    expect(stillLive).not.toBeNull();

    // The SAME challenge can still succeed afterward with the real code.
    const code = await generate({ secret, period: 30 });
    const retryOk = await mfa.verifyMfaChallengeWithTotp(challenge!.id, userId, code);
    expect(retryOk).toBe(true);

    await mfa.disableMfa(userId);
  });

  it("happy path + duplicate: a backup code verifies once and is rejected on reuse", async () => {
    const { backupCodes } = await enroll(userId);
    const oneCode = backupCodes[0];

    const tokenA = await mfa.createMfaChallenge(userId, null, null);
    const challengeA = await mfa.getMfaChallenge(tokenA);
    const firstOk = await mfa.verifyMfaChallengeWithBackupCode(challengeA!.id, userId, oneCode);
    expect(firstOk).toBe(true);

    const remaining = await mfa.countRemainingBackupCodes(userId);
    expect(remaining).toBe(9);

    const tokenB = await mfa.createMfaChallenge(userId, null, null);
    const challengeB = await mfa.getMfaChallenge(tokenB);
    const secondOk = await mfa.verifyMfaChallengeWithBackupCode(challengeB!.id, userId, oneCode);
    expect(secondOk).toBe(false);

    await mfa.disableMfa(userId);
  });

  it("wrong-user isolation: a backup code issued to one user never verifies for another user's challenge", async () => {
    const { backupCodes: userCodes } = await enroll(userId);
    const { backupCodes: otherCodes } = await enroll(otherUserId);
    expect(userCodes[0]).not.toBe(otherCodes[0]);

    const token = await mfa.createMfaChallenge(otherUserId, null, null);
    const challenge = await mfa.getMfaChallenge(token);
    // Try to use userId's own backup code against otherUserId's challenge.
    const ok = await mfa.verifyMfaChallengeWithBackupCode(challenge!.id, otherUserId, userCodes[0]);
    expect(ok).toBe(false);

    // otherUserId's own code still works on that same still-live challenge.
    const okOwn = await mfa.verifyMfaChallengeWithBackupCode(challenge!.id, otherUserId, otherCodes[0]);
    expect(okOwn).toBe(true);

    await mfa.disableMfa(userId);
    await mfa.disableMfa(otherUserId);
  });

  it("rollback/failure: disabling MFA clears the secret and every backup code, and a stale challenge can no longer verify", async () => {
    const { secret, backupCodes } = await enroll(userId);
    const token = await mfa.createMfaChallenge(userId, null, null);
    const challenge = await mfa.getMfaChallenge(token);

    await mfa.disableMfa(userId);

    const [row] = await db
      .select({ mfaEnabled: schema.users.mfaEnabled, mfaSecret: schema.users.mfaSecret })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(row.mfaEnabled).toBe(false);
    expect(row.mfaSecret).toBeNull();

    const remaining = await mfa.countRemainingBackupCodes(userId);
    expect(remaining).toBe(0);

    const code = await generate({ secret, period: 30 });
    const ok = await mfa.verifyMfaChallengeWithTotp(challenge!.id, userId, code);
    expect(ok).toBe(false);

    const backupOk = await mfa.verifyMfaChallengeWithBackupCode(challenge!.id, userId, backupCodes[0]);
    expect(backupOk).toBe(false);
  });

  it("edge case: regenerating backup codes invalidates every previous one", async () => {
    const { backupCodes: oldCodes } = await enroll(userId);
    const newCodes = await mfa.regenerateBackupCodes(userId);

    expect(newCodes).toHaveLength(10);
    expect(new Set(newCodes).has(oldCodes[0])).toBe(false);

    const token = await mfa.createMfaChallenge(userId, null, null);
    const challenge = await mfa.getMfaChallenge(token);
    const oldStillWorks = await mfa.verifyMfaChallengeWithBackupCode(challenge!.id, userId, oldCodes[0]);
    expect(oldStillWorks).toBe(false);

    const newWorks = await mfa.verifyMfaChallengeWithBackupCode(challenge!.id, userId, newCodes[0]);
    expect(newWorks).toBe(true);

    await mfa.disableMfa(userId);
  });

  it("edge case: an expired/garbage challenge token never resolves", async () => {
    const nonexistent = await mfa.getMfaChallenge("this-token-does-not-exist");
    expect(nonexistent).toBeNull();
  });
});
