import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac/guard";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { mfaEnrollConfirmSchema } from "@/lib/validation/auth";
import { confirmMfaEnrollment } from "@/lib/auth/mfa";
import { recordAuditLog } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Confirms MFA enrollment: the client sends back the secret it got from
 * POST .../enroll (never persisted server-side until now) plus a live
 * 6-digit code from whatever authenticator app scanned that QR. Only on a
 * valid code does the secret actually get written to users.mfaSecret and
 * MFA get switched on — see confirmMfaEnrollment's own doc comment.
 * Returns the newly-issued backup codes IN THE CLEAR, exactly once.
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requireAuth();

    const limited = rateLimit(`mfa-enroll-confirm:${session.user.id}`, { limit: 10, windowMs: 60_000 });
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again in a minute." },
        { status: 429 },
      );
    }

    const parsed = await parseJsonBody(request, mfaEnrollConfirmSchema);
    if (!parsed.ok) return parsed.response;

    const result = await confirmMfaEnrollment(session.user.id, parsed.data.secret, parsed.data.code);
    if (!result.ok) {
      await recordAuditLog({
        userId: session.user.id,
        action: "auth.mfa_enroll_failed",
        resourceType: "user",
        resourceId: session.user.id,
        ipAddress: getClientIp(request),
      });
      return NextResponse.json(
        { error: "That code didn't match. Check your authenticator app and try again." },
        { status: 400 },
      );
    }

    await recordAuditLog({
      userId: session.user.id,
      action: "auth.mfa_enabled",
      resourceType: "user",
      resourceId: session.user.id,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ ok: true, backupCodes: result.backupCodes });
  } catch (err) {
    return toErrorResponse(err);
  }
}
