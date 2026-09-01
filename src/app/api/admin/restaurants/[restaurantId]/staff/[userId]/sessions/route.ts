import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userRoles } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { listActiveSessionsForUser } from "@/lib/auth/session";

/**
 * Gap-audit P1 fix (Finding 2) — the real active-sessions list the
 * restaurant detail page was missing: today a support agent could only
 * fire a blind "revoke everything," with no visibility into what they
 * were actually revoking. This lists every currently-unexpired session for
 * one staff member — device (user agent), IP, and created/expires
 * timestamps (see listActiveSessionsForUser's own comment on why there's
 * no separate "last active" field: this table doesn't track one).
 *
 * Scoped to (userId, restaurantId) together, same as the existing bulk
 * revoke-sessions route this sits alongside — the target must actually
 * hold (or have held) a role at this restaurant, so this can't be used to
 * peek at an arbitrary user's sessions by guessing an id.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ restaurantId: string; userId: string }> },
) {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);
    const { restaurantId, userId } = await ctx.params;

    const [grant] = await db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.restaurantId, restaurantId)))
      .limit(1);
    if (!grant) {
      return NextResponse.json(
        { error: "This user has no role at this restaurant." },
        { status: 404 },
      );
    }

    const sessions = await listActiveSessionsForUser(userId);
    return NextResponse.json({ sessions });
  } catch (err) {
    return toErrorResponse(err);
  }
}
