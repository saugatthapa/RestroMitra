import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { purgeExpiredAttendancePhotos, getAttendancePhotoRetentionDays } from "@/lib/attendance-photos-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Platform Control Center / Phase 12 (Attendance overhaul, Track B) — the
 * retention purge for attendance selfies, invoked on demand from
 * /admin/system rather than run by any in-app scheduler (this codebase
 * has no background job runner — see attendance-photos-db.ts's own note).
 * An operator wires this to an external cron/scheduled task hitting this
 * endpoint with a platform-admin session; documented in .env.example
 * alongside ATTENDANCE_PHOTO_RETENTION_DAYS.
 *
 * MANAGE_SYSTEM-gated — same platform permission the maintenance-mode
 * toggle and system health page use, since this is exactly that class of
 * operational, cross-tenant action.
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SYSTEM);

    const retentionDays = getAttendancePhotoRetentionDays();
    const result = await purgeExpiredAttendancePhotos(retentionDays);

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "admin.attendance_photos_purged",
      resourceType: "platform_system",
      ipAddress: getClientIp(request),
      metadata: { retentionDays, ...result },
    });

    return NextResponse.json({ retentionDays, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
