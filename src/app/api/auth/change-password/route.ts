import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { changePasswordSchema } from "@/lib/validation/auth";
import { hashPassword, verifyPassword, validatePasswordStrength } from "@/lib/auth/password";
import { requireAuth } from "@/lib/rbac/guard";
import { destroyOtherSessions } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { toErrorResponse } from "@/lib/api-route-helpers";

/**
 * RC audit P1 fix — self-service change-password for an already
 * logged-in user. Requires the CURRENT password (not just an active
 * session) — a session cookie proves "this browser is logged in," not
 * "this is really the account owner acting," and password changes are
 * exactly the kind of action (alongside things like removing a recovery
 * method) that should re-assert the stronger proof. Same
 * validatePasswordStrength() rule register uses, so a changed password is
 * never weaker than what registration would have accepted.
 *
 * On success, every OTHER session for this user is revoked (see
 * destroyOtherSessions's own doc comment) — the real-world reason to
 * change a password is usually "I think someone else might have this,"
 * and leaving their session alive would defeat the point. The CALLER's
 * own session is deliberately kept alive so the user isn't logged out by
 * their own successful password change.
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requireAuth();

    // Rate limited per-user (not just per-IP) — this is an authenticated
    // action, so the user id is a reliable key, and it directly blocks an
    // attacker who stole a session cookie from brute-forcing the current
    // password to defeat this exact "prove you still know it" check.
    const limited = rateLimit(`change-password:${session.user.id}`, {
      limit: 8,
      windowMs: 60_000,
    });
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again in a minute." },
        { status: 429 },
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid input." },
        { status: 400 },
      );
    }
    const { currentPassword, newPassword } = parsed.data;

    const strengthError = validatePasswordStrength(newPassword);
    if (strengthError) {
      return NextResponse.json({ error: strengthError }, { status: 400 });
    }

    const rows = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    const user = rows[0];
    if (!user) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }

    const currentValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!currentValid) {
      await recordAuditLog({
        userId: session.user.id,
        action: "auth.change_password_failed",
        resourceType: "user",
        resourceId: session.user.id,
        ipAddress: getClientIp(request),
      });
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
    }

    const newHash = await hashPassword(newPassword);
    await db.update(users).set({ passwordHash: newHash }).where(eq(users.id, session.user.id));

    const revokedCount = await destroyOtherSessions(session.user.id, session.sessionId);

    await recordAuditLog({
      userId: session.user.id,
      action: "auth.password_changed",
      resourceType: "user",
      resourceId: session.user.id,
      ipAddress: getClientIp(request),
      metadata: { otherSessionsRevoked: revokedCount },
    });

    return NextResponse.json({ ok: true, otherSessionsRevoked: revokedCount });
  } catch (err) {
    return toErrorResponse(err);
  }
}
