import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { forgotPasswordSchema } from "@/lib/validation/auth";
import { createPasswordResetToken } from "@/lib/auth/password-reset";
import { sendTransactionalEmail } from "@/lib/email";
import { recordAuditLog } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const GENERIC_RESPONSE = {
  ok: true,
  message:
    "If that phone number has an account with an email on file, we've sent a password reset link to it.",
};

/**
 * Commercial Launch Phase B.3 — Forgot Password (request step).
 *
 * Deliberately returns the EXACT same 200 response no matter what: no
 * account for that phone, an account with no email on file, or a real send
 * — same status code, same body, every time. Anything that varied by
 * outcome (a 404 for "no such phone", a different message for "no email
 * on file") would let an unauthenticated caller enumerate which phone
 * numbers are registered, exactly the "deliberately generic message" this
 * app already tries for on register (see that route's own comment) —
 * this endpoint just doesn't have register's status-code leak, since
 * there's no reason a reset-request response should ever differ.
 *
 * This app has no SMS/OTP sending capability, and email is optional at
 * registration — a user with no email on file (or whose deployment has
 * RESEND_API_KEY unset, see email.ts) has no self-service path here and
 * needs to ask a restaurant owner/support to sort it out directly. That's
 * a real, known limitation, not silently swallowed: the forgot-password
 * page's own copy says so.
 */
// QA hardening (P2 backlog): this route previously had no top-level
// try/catch, unlike the rest of this app's routes (see login/route.ts's
// comment for the general fix). This one needs a BESPOKE catch rather
// than the shared toErrorResponse, though: toErrorResponse returns a
// distinct 500 body/status, which would break the one invariant this
// route's whole design hinges on (its own doc comment above) — the exact
// same response for every outcome, so an unauthenticated caller can never
// learn anything from how the response differs. An unexpected failure
// (a DB hiccup, etc.) still needs to be logged/reported so it doesn't
// silently vanish, but the response back to the caller must stay
// GENERIC_RESPONSE regardless.
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    return await handleForgotPassword(request);
  } catch (err) {
    console.error("forgot-password: unexpected error", err);
    Sentry.captureException(err);
    return NextResponse.json(GENERIC_RESPONSE);
  }
}

async function handleForgotPassword(request: Request) {
  const ip = getClientIp(request) ?? "unknown";

  const body = await request.json().catch(() => null);
  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }
  const { phone } = parsed.data;

  // Same dual IP+phone keying as login — bounds both "one attacker hammers
  // many phone numbers from one IP" and "many IPs hammer one phone number".
  const limitedByIp = await rateLimit(`reset-request-ip:${ip}`, { limit: 10, windowMs: 60_000 });
  const limitedByPhone = await rateLimit(`reset-request-phone:${phone}`, { limit: 3, windowMs: 60_000 });
  if (!limitedByIp.allowed || !limitedByPhone.allowed) {
    // Still the generic response, not a 429 with a distinct body — even
    // "you're rate limited" is a signal an enumerating caller could use to
    // learn something, however marginal. The rate limit still does its
    // job silently: it just declines to send another email/create another
    // token past the threshold.
    return NextResponse.json(GENERIC_RESPONSE);
  }

  const rows = await db
    .select({ id: users.id, email: users.email, isActive: users.isActive })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);
  const user = rows[0];

  if (user && user.isActive && user.email) {
    const token = await createPasswordResetToken(user.id, ip);
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const resetLink = `${appUrl}/reset-password/${token}`;

    await sendTransactionalEmail(
      user.email,
      "Reset your RestroMitra password",
      `Someone (hopefully you) asked to reset the password for your RestroMitra account.\n\n` +
        `Reset it here: ${resetLink}\n\n` +
        `This link works once and expires in 30 minutes. If you didn't request this, you can safely ignore this email — your password hasn't been changed.`,
    );

    await recordAuditLog({
      userId: user.id,
      action: "auth.password_reset_requested",
      resourceType: "user",
      resourceId: user.id,
      ipAddress: ip,
    });
  }

  return NextResponse.json(GENERIC_RESPONSE);
}
