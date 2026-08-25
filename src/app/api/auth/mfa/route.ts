import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAuth } from "@/lib/rbac/guard";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { countRemainingBackupCodes } from "@/lib/auth/mfa";

/** This account's current MFA status — enabled, when, and how many backup codes are left. Read by the account settings page. */
export async function GET() {
  try {
    const session = await requireAuth();

    const [row] = await db
      .select({ mfaEnabled: users.mfaEnabled, mfaEnabledAt: users.mfaEnabledAt })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    const backupCodesRemaining = row?.mfaEnabled ? await countRemainingBackupCodes(session.user.id) : 0;

    return NextResponse.json({
      enabled: row?.mfaEnabled ?? false,
      enabledAt: row?.mfaEnabledAt ?? null,
      backupCodesRemaining,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
