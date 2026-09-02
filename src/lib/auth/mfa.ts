import "server-only";
import { randomBytes } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { generateSecret, generateURI, verify } from "otplib";
import { db } from "@/db";
import { mfaBackupCodes, mfaChallenges, users } from "@/db/schema";
import { generateToken, hashToken } from "./session";

/**
 * Commercial Launch Phase B.4 — TOTP multi-factor auth. Uses otplib's
 * functional API (RFC 6238, Google-Authenticator-compatible) rather than
 * hand-rolling HMAC-SHA1/base32/otpauth-URI construction — same "small,
 * well-audited dependency over hand-rolled crypto" choice this codebase
 * already made for bcryptjs (passwords) and qrcode (table/website QR
 * codes). SMS/OTP delivery isn't an option here (see forgot-password's
 * own doc comment on why this app has no SMS capability) — an
 * authenticator app is the only realistic second factor.
 */

const ISSUER = "RestroKendra";
const TOTP_PERIOD_SECONDS = 30;
// otplib's `epochTolerance` is denominated in SECONDS (not time steps,
// despite how easy that is to misread) — see @otplib/totp's own examples
// ("epochTolerance: 30" tolerating drift "within 30 seconds"). Setting
// this to one full period gives ±1 time step of clock-drift tolerance
// between server and phone; otplib's own default is 0 (exact time step
// only), which is unrealistically strict for real devices.
const EPOCH_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS;
const MFA_CHALLENGE_DURATION_MS = 10 * 60 * 1000;
const BACKUP_CODE_COUNT = 10;

export type MfaEnrollment = { secret: string; otpauthUri: string };

/** Generates a fresh TOTP secret + its otpauth:// URI for QR enrollment. Does NOT persist anything — the caller stores the secret once the user proves they can use it (see confirmMfaEnrollment). */
export function generateMfaEnrollment(accountLabel: string): MfaEnrollment {
  const secret = generateSecret();
  const otpauthUri = generateURI({ issuer: ISSUER, label: accountLabel, secret });
  return { secret, otpauthUri };
}

/**
 * Verifies a 6-digit code against a secret, honoring this user's
 * mfaLastUsedTimeStep as `afterTimeStep` so a single valid code can never
 * be replayed within (or before) the window it was already accepted in.
 * On success, returns the timeStep that matched, which the CALLER must
 * persist as the new mfaLastUsedTimeStep — this function has no DB
 * side effects itself, staying a pure verification + one enrollment write
 * split, matching password-reset.ts's "verify here, persist in the
 * transactional caller" shape.
 */
async function verifyTotpCode(
  secret: string,
  code: string,
  afterTimeStep: number | null,
): Promise<{ valid: true; timeStep: number } | { valid: false }> {
  const result = await verify({
    secret,
    token: code,
    period: TOTP_PERIOD_SECONDS,
    epochTolerance: EPOCH_TOLERANCE_SECONDS,
    afterTimeStep: afterTimeStep ?? undefined,
  });
  // otplib's verify() is typed to return a TOTP-or-HOTP result union (this
  // app never passes `strategy: "hotp"`, so at runtime it's always the
  // TOTP branch, which always carries `timeStep` — see VerifyResultValid
  // in @otplib/totp). The `in` check narrows the type accordingly rather
  // than casting blindly.
  if (!result.valid || !("timeStep" in result)) return { valid: false };
  return { valid: true, timeStep: result.timeStep };
}

function generateBackupCode(): string {
  // 6 random bytes -> 12 hex chars, uppercased — easy to read/type back
  // (fixed length, unlike stripping non-alphanumerics out of a base64url
  // token), ~48 bits of entropy per code, plenty given each is also
  // rate-limited and single-use (see mfa/verify's rate limiting).
  return randomBytes(6).toString("hex").toUpperCase();
}

/**
 * Confirms enrollment: verifies the user's first live code against the
 * not-yet-trusted secret, and if it matches, atomically flips mfaEnabled
 * on, stores the secret + this first timeStep (so the SAME code can't
 * also be replayed as the first login-time verification), and issues a
 * fresh batch of backup codes — returned in the clear exactly once, never
 * retrievable again (only their hashes are stored, same as every other
 * token in this app).
 */
export async function confirmMfaEnrollment(
  userId: string,
  secret: string,
  code: string,
): Promise<{ ok: true; backupCodes: string[] } | { ok: false }> {
  const result = await verifyTotpCode(secret, code, null);
  if (!result.valid) return { ok: false };

  const rawCodes = Array.from({ length: BACKUP_CODE_COUNT }, () => generateBackupCode());

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        mfaEnabled: true,
        mfaSecret: secret,
        mfaEnabledAt: new Date(),
        mfaLastUsedTimeStep: result.timeStep,
      })
      .where(eq(users.id, userId));

    // Enrolling again (e.g. after a prior disable) replaces any leftover
    // backup codes rather than accumulating stale ones.
    await tx.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
    await tx.insert(mfaBackupCodes).values(
      rawCodes.map((raw) => ({ userId, codeHash: hashToken(raw) })),
    );
  });

  return { ok: true, backupCodes: rawCodes };
}

/** Disables MFA entirely — clears the secret and every backup code. Caller (the /mfa/disable route) is responsible for re-verifying the user's password first, same "prove you still know it" bar as change-password. */
export async function disableMfa(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ mfaEnabled: false, mfaSecret: null, mfaEnabledAt: null, mfaLastUsedTimeStep: null })
      .where(eq(users.id, userId));
    await tx.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
  });
}

/** Issues a fresh batch of backup codes, invalidating every previous one — for a user who's used most of theirs up or thinks a code leaked. Returns the new codes in the clear, once. */
export async function regenerateBackupCodes(userId: string): Promise<string[]> {
  const rawCodes = Array.from({ length: BACKUP_CODE_COUNT }, () => generateBackupCode());
  await db.transaction(async (tx) => {
    await tx.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
    await tx.insert(mfaBackupCodes).values(
      rawCodes.map((raw) => ({ userId, codeHash: hashToken(raw) })),
    );
  });
  return rawCodes;
}

/**
 * Issues a new MFA challenge for a user who just passed password
 * verification at login — the raw token is returned directly (never
 * persisted) for the login route to hand back in its response body; see
 * mfaChallenges' own schema comment for why this isn't a cookie.
 */
export async function createMfaChallenge(
  userId: string,
  ipAddress: string | null,
  userAgent: string | null,
): Promise<string> {
  const token = generateToken();
  await db.insert(mfaChallenges).values({
    userId,
    tokenHash: hashToken(token),
    ipAddress,
    userAgent,
    expiresAt: new Date(Date.now() + MFA_CHALLENGE_DURATION_MS),
  });
  return token;
}

export type MfaChallenge = { id: string; userId: string };

/** Looks up a live (unexpired, unused) challenge WITHOUT consuming it — a failed code attempt should not burn the challenge, only a successful one should (see verifyMfaChallengeWithTotp/verifyMfaChallengeWithBackupCode). */
export async function getMfaChallenge(token: string): Promise<MfaChallenge | null> {
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ id: mfaChallenges.id, userId: mfaChallenges.userId })
    .from(mfaChallenges)
    .where(
      and(
        eq(mfaChallenges.tokenHash, tokenHash),
        isNull(mfaChallenges.usedAt),
        gt(mfaChallenges.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Verifies a live TOTP code against `userId`'s enrolled secret. On
 * success, claims the challenge and persists the new mfaLastUsedTimeStep
 * in the same transaction — both must succeed together, or neither does,
 * so a code can never be accepted without its replay-protection state
 * actually being recorded.
 *
 * QA hardening pass — the read of mfaLastUsedTimeStep, the TOTP
 * verification against it, and the eventual write of the new
 * mfaLastUsedTimeStep now ALL happen under one `SELECT ... FOR UPDATE`
 * lock on this user's row, inside one transaction. Previously the read +
 * verify happened before the transaction even opened: two concurrent
 * login attempts for the SAME user, each holding a DIFFERENT valid MFA
 * challenge (e.g. two browser tabs, or an attacker who obtained two
 * challenge tokens), submitting the SAME still-valid TOTP code at the
 * same moment, would both read the same (stale) mfaLastUsedTimeStep,
 * both pass verifyTotpCode, and both commit — each claiming its own
 * distinct challengeId (the per-challenge CAS below was already race-safe
 * on its own, but only protects re-use of ONE challenge, not cross-
 * challenge replay of one code). Locking the user row first serializes
 * the two attempts: the second one blocks until the first commits its
 * mfaLastUsedTimeStep update, then re-reads it and correctly fails
 * verifyTotpCode against the now-updated value.
 */
export async function verifyMfaChallengeWithTotp(
  challengeId: string,
  userId: string,
  code: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ mfaEnabled: users.mfaEnabled, mfaSecret: users.mfaSecret, mfaLastUsedTimeStep: users.mfaLastUsedTimeStep })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")
      .limit(1);
    if (!user?.mfaEnabled || !user.mfaSecret) return false;

    const result = await verifyTotpCode(user.mfaSecret, code, user.mfaLastUsedTimeStep);
    if (!result.valid) return false;

    const [claimed] = await tx
      .update(mfaChallenges)
      .set({ usedAt: new Date() })
      .where(and(eq(mfaChallenges.id, challengeId), isNull(mfaChallenges.usedAt)))
      .returning({ id: mfaChallenges.id });
    if (!claimed) return false;

    await tx.update(users).set({ mfaLastUsedTimeStep: result.timeStep }).where(eq(users.id, userId));
    return true;
  });
}

/**
 * Verifies a backup code and, if it matches an unused one, claims BOTH
 * that code and the challenge in one transaction — same "claim together
 * or not at all" reasoning as the TOTP path above, so a backup code can
 * never be burned without actually completing a login.
 */
export async function verifyMfaChallengeWithBackupCode(
  challengeId: string,
  userId: string,
  rawCode: string,
): Promise<boolean> {
  const codeHash = hashToken(rawCode.trim().toUpperCase());
  return db.transaction(async (tx) => {
    const [claimedCode] = await tx
      .update(mfaBackupCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(mfaBackupCodes.userId, userId),
          eq(mfaBackupCodes.codeHash, codeHash),
          isNull(mfaBackupCodes.usedAt),
        ),
      )
      .returning({ id: mfaBackupCodes.id });
    if (!claimedCode) return false;

    const [claimedChallenge] = await tx
      .update(mfaChallenges)
      .set({ usedAt: new Date() })
      .where(and(eq(mfaChallenges.id, challengeId), isNull(mfaChallenges.usedAt)))
      .returning({ id: mfaChallenges.id });

    return Boolean(claimedChallenge);
  });
}

/** Count of this user's still-unused backup codes — surfaced in account settings so "you're down to 1 code left" is visible before they're locked out. */
export async function countRemainingBackupCodes(userId: string): Promise<number> {
  const rows = await db
    .select({ id: mfaBackupCodes.id })
    .from(mfaBackupCodes)
    .where(and(eq(mfaBackupCodes.userId, userId), isNull(mfaBackupCodes.usedAt)));
  return rows.length;
}
