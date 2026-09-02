import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { platformImpersonationSessions, restaurants, users } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform Control Center (Phase 8) — lists every currently-active
 * impersonation session, for the platform dashboard's "active
 * impersonation" status view (spec item 24) and its "Revoke" control.
 * Same MANAGE_SUPPORT gate as the revoke route itself.
 */
export async function GET() {
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);

    // QA hardening (P2 backlog) — see ai-providers/route.ts's matching
    // comment; shares the same admin-read:user bucket.
    const limit = await rateLimit(`admin-read:user:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const rows = await db
      .select({
        id: platformImpersonationSessions.id,
        adminUserId: platformImpersonationSessions.adminUserId,
        adminFullName: users.fullName,
        targetRestaurantId: platformImpersonationSessions.targetRestaurantId,
        targetRestaurantName: restaurants.name,
        reason: platformImpersonationSessions.reason,
        mode: platformImpersonationSessions.mode,
        startedAt: platformImpersonationSessions.startedAt,
        expiresAt: platformImpersonationSessions.expiresAt,
      })
      .from(platformImpersonationSessions)
      .innerJoin(restaurants, eq(platformImpersonationSessions.targetRestaurantId, restaurants.id))
      .innerJoin(users, eq(platformImpersonationSessions.adminUserId, users.id))
      .where(eq(platformImpersonationSessions.status, "active"));

    return NextResponse.json({
      sessions: rows.map((row) => ({
        ...row,
        startedAt: row.startedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
