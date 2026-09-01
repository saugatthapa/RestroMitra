import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAuth } from "@/lib/rbac/guard";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { mfaDisableSchema } from "@/lib/validation/auth";
import { verifyPassword } from "@/lib/auth/password";
import { disableMfa } from "@/lib/auth/mfa";
import { recordAuditLog } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Turns MFA off. Requires the CURRENT password — same "a session cookie
 * proves this browser is logged in, not that this is really the account
 * owner acting" reasoning change-password's own doc comment gives, and
 * arguably even more important here: disabling MFA is exactly the kind of
 * action an attacker with a stolen session would want to take before
 * doing anything else.
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requireAuth();

    const limited = await rateLimit(`mfa-disable:${session.user.id}`, { limit: 8, windowMs: 60_000 });
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again in a minute." },
        { status: 429 },
      );
    }

    const parsed = await parseJsonBody(request, mfaDisableSchema);
    if (!parsed.ok) return parsed.response;

    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    if (!row) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }

    const valid = await verifyPassword(parsed.data.currentPassword, row.passwordHash);
    if (!valid) {
      await recordAuditLog({
        userId: session.user.id,
        action: "auth.mfa_disable_failed",
        resourceType: "user",
        resourceId: session.user.id,
        ipAddress: getClientIp(request),
      });
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
    }

    await disableMfa(session.user.id);

    await recordAuditLog({
      userId: session.user.id,
      action: "auth.mfa_disabled",
      resourceType: "user",
      resourceId: session.user.id,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
