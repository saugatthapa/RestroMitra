import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAuth } from "@/lib/rbac/guard";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { mfaDisableSchema as regenerateBackupCodesSchema } from "@/lib/validation/auth";
import { verifyPassword } from "@/lib/auth/password";
import { regenerateBackupCodes } from "@/lib/auth/mfa";
import { recordAuditLog } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Issues a fresh batch of 10 backup codes, invalidating every previous
 * one — for a user who's used most of theirs up, or thinks a code
 * leaked. Same "prove you still know the current password" bar as
 * mfa/disable (reuses that exact schema shape — `{ currentPassword }` —
 * rather than a near-duplicate one, since the input is identical).
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requireAuth();

    const limited = rateLimit(`mfa-backup-regen:${session.user.id}`, { limit: 5, windowMs: 60_000 });
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again in a minute." },
        { status: 429 },
      );
    }

    const parsed = await parseJsonBody(request, regenerateBackupCodesSchema);
    if (!parsed.ok) return parsed.response;

    const [row] = await db
      .select({ passwordHash: users.passwordHash, mfaEnabled: users.mfaEnabled })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    if (!row) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }
    if (!row.mfaEnabled) {
      return NextResponse.json({ error: "Two-factor authentication isn't enabled." }, { status: 400 });
    }

    const valid = await verifyPassword(parsed.data.currentPassword, row.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
    }

    const backupCodes = await regenerateBackupCodes(session.user.id);

    await recordAuditLog({
      userId: session.user.id,
      action: "auth.mfa_backup_codes_regenerated",
      resourceType: "user",
      resourceId: session.user.id,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ ok: true, backupCodes });
  } catch (err) {
    return toErrorResponse(err);
  }
}
