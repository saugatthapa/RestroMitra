import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac/guard";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { generateMfaEnrollment } from "@/lib/auth/mfa";
import { renderQrDataUrl } from "@/lib/qr";
import { rateLimit } from "@/lib/rate-limit";
import { hasValidCsrfHeader } from "@/lib/request";

/**
 * Commercial Launch Phase B.4 — starts MFA enrollment. Generates a fresh
 * TOTP secret and its otpauth:// URI/QR code but deliberately does NOT
 * persist anything yet (see mfa.ts's generateMfaEnrollment doc comment) —
 * the secret only gets written to the database once the user proves they
 * can actually generate a valid code with it, via POST .../enroll/confirm.
 * The client holds the secret in memory between this call and that one
 * (same "no half-finished server-side state" shape login's own
 * challengeToken uses).
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requireAuth();

    const limited = rateLimit(`mfa-enroll:${session.user.id}`, { limit: 10, windowMs: 60_000 });
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again in a minute." },
        { status: 429 },
      );
    }

    const accountLabel = session.user.email || session.user.phone;
    const { secret, otpauthUri } = generateMfaEnrollment(accountLabel);
    const qrDataUrl = await renderQrDataUrl(otpauthUri);

    return NextResponse.json({ secret, otpauthUri, qrDataUrl });
  } catch (err) {
    return toErrorResponse(err);
  }
}
