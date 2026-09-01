import { NextResponse } from "next/server";
import { resetPasswordSchema } from "@/lib/validation/auth";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { redeemPasswordResetToken } from "@/lib/auth/password-reset";
import { destroyAllSessions } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { toErrorResponse } from "@/lib/api-route-helpers";

const GENERIC_ERROR = "This reset link is invalid or has expired. Request a new one.";

/**
 * Commercial Launch Phase B.3 — Forgot Password (completion step).
 *
 * Deliberately unauthenticated — the whole point is the caller has no
 * session, only the token from the emailed link — but still CSRF-checked
 * (see hasValidCsrfHeader's own doc comment: the header check doesn't
 * depend on a session, only on the request having come from this app's
 * own JS) and rate-limited by IP to blunt token-guessing, mirroring
 * login's brute-force protections even though the "password" being
 * guessed here is a 256-bit token rather than something a human chose.
 *
 * On success, EVERY session for the account is destroyed (not "every
 * OTHER session" the way change-password does it) — there is no caller
 * session to exempt here, and a password reset is precisely the scenario
 * (account was locked out, possibly because someone else has it) where
 * every existing session should stop being trusted. The person resetting
 * it logs in fresh afterward.
 */
// QA hardening (P2 backlog): see login/route.ts's comment for why every
// pre-auth route now wraps its body in try/catch + toErrorResponse —
// consistent JSON error shape and Sentry reporting on truly unexpected
// failures, no behavior change on any explicit return path.
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    return await handleResetPassword(request);
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function handleResetPassword(request: Request) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await rateLimit(`reset-complete-ip:${ip}`, { limit: 15, windowMs: 60_000 });
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again in a minute." },
      { status: 429 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }
  const { token, newPassword } = parsed.data;

  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) {
    return NextResponse.json({ error: strengthError }, { status: 400 });
  }

  const newHash = await hashPassword(newPassword);
  const result = await redeemPasswordResetToken(token, newHash);

  if (!result) {
    await recordAuditLog({
      action: "auth.password_reset_failed",
      resourceType: "user",
      ipAddress: ip,
      metadata: { reason: "invalid_or_expired_token" },
    });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
  }

  const revokedCount = await destroyAllSessions(result.userId);

  await recordAuditLog({
    userId: result.userId,
    action: "auth.password_reset_completed",
    resourceType: "user",
    resourceId: result.userId,
    ipAddress: ip,
    metadata: { sessionsRevoked: revokedCount },
  });

  return NextResponse.json({ ok: true });
}
