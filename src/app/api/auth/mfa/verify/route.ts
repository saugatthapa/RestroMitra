import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { mfaVerifySchema } from "@/lib/validation/auth";
import {
  getMfaChallenge,
  verifyMfaChallengeWithBackupCode,
  verifyMfaChallengeWithTotp,
} from "@/lib/auth/mfa";
import { createSession } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { toErrorResponse } from "@/lib/api-route-helpers";

const GENERIC_ERROR = "Invalid or expired code.";
const CHALLENGE_EXPIRED_ERROR = "Your login has expired. Please log in again.";

/**
 * Commercial Launch Phase B.4 — MFA login-time verification (the second
 * half of a two-step login; see login/route.ts's own comment). Also
 * unauthenticated by design — the caller has no session yet, only the
 * challengeToken login handed back — but still CSRF-checked and rate
 * limited (both by IP and by the challenge itself, so a stolen/guessed
 * challengeToken can't be brute-forced past a 6-digit code indefinitely).
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
    return await handleMfaVerify(request);
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function handleMfaVerify(request: Request) {
  const ip = getClientIp(request) ?? "unknown";
  const limitedByIp = rateLimit(`mfa-verify-ip:${ip}`, { limit: 20, windowMs: 60_000 });
  if (!limitedByIp.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again in a minute." },
      { status: 429 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = mfaVerifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }
  const { challengeToken, code, backupCode } = parsed.data;

  const challenge = await getMfaChallenge(challengeToken);
  if (!challenge) {
    return NextResponse.json({ error: CHALLENGE_EXPIRED_ERROR }, { status: 400 });
  }

  // Rate limited per-challenge too, not just per-IP — bounds a brute
  // force attempt against ONE stolen challenge even if it's spread across
  // many IPs.
  const limitedByChallenge = rateLimit(`mfa-verify-challenge:${challenge.id}`, {
    limit: 8,
    windowMs: 60_000,
  });
  if (!limitedByChallenge.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again in a minute." },
      { status: 429 },
    );
  }

  const ok = code
    ? await verifyMfaChallengeWithTotp(challenge.id, challenge.userId, code)
    : await verifyMfaChallengeWithBackupCode(challenge.id, challenge.userId, backupCode!);

  if (!ok) {
    await recordAuditLog({
      userId: challenge.userId,
      action: "auth.mfa_verify_failed",
      resourceType: "user",
      resourceId: challenge.userId,
      ipAddress: ip,
      metadata: { method: code ? "totp" : "backup_code" },
    });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  await createSession({
    userId: challenge.userId,
    userAgent: request.headers.get("user-agent"),
    ipAddress: ip,
  });

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, challenge.userId));

  await recordAuditLog({
    userId: challenge.userId,
    action: "auth.login",
    resourceType: "user",
    resourceId: challenge.userId,
    ipAddress: ip,
    metadata: { mfa: true, method: code ? "totp" : "backup_code" },
  });

  return NextResponse.json({ ok: true });
}
