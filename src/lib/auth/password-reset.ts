import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";
import { generateToken, hashToken } from "./session";

/**
 * Commercial Launch Phase B.3 — Forgot Password.
 *
 * Short-lived on purpose: a reset link is a bearer credential that travels
 * over email in plain text, so its blast radius (how long a leaked/
 * intercepted link stays useful) needs to be much smaller than a session's
 * 30 days. 30 minutes is generous enough for someone to receive and click
 * an email, tight enough that a stale, forwarded, or previously-abandoned
 * link stops working on its own well before anyone would think to worry
 * about it.
 */
const RESET_TOKEN_DURATION_MS = 30 * 60 * 1000;

/**
 * Issues a new single-use reset token for `userId` and returns the RAW
 * token (only ever held in memory here and in the emailed link — never
 * written to the database; only its hash is, via the same generateToken/
 * hashToken primitives sessions.ts uses).
 *
 * Any of this user's existing UNUSED tokens are invalidated first, so at
 * most one reset link is ever live at a time — requesting a new one (e.g.
 * "didn't get the email, let me try again") retires the previous link
 * instead of leaving multiple valid links outstanding.
 */
export async function createPasswordResetToken(
  userId: string,
  requestIp: string | null,
): Promise<string> {
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));

  const token = generateToken();
  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash: hashToken(token),
    requestIp,
    expiresAt: new Date(Date.now() + RESET_TOKEN_DURATION_MS),
  });
  return token;
}

/**
 * Atomically redeems a reset token: claims it (CAS UPDATE — only a row
 * that is still unused AND unexpired can be claimed, so two concurrent
 * submissions of the same link can never both succeed) and writes the new
 * password hash, in one transaction. Returns the userId on success, or
 * null if the token is missing/already used/expired — the caller can't
 * tell which of those three it was, deliberately (same "don't reveal
 * anything an attacker could use" posture as login's generic error).
 */
export async function redeemPasswordResetToken(
  token: string,
  newPasswordHash: string,
): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(token);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });

    if (!claimed) return null;

    await tx.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, claimed.userId));

    return { userId: claimed.userId };
  });
}
