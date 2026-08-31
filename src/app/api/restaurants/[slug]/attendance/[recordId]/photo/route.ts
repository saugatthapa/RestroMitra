import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { FEATURES } from "@/lib/feature-catalog";
import { hasPermission } from "@/lib/rbac/guard";
import { createAttendancePhotoDownloadUrl, isObjectStorageConfigured } from "@/lib/storage/object-storage-s3";
import { HttpError } from "@/lib/http-error";

/**
 * Phase 12 (Attendance overhaul, Track B) — a short-lived signed URL to
 * VIEW one attendance photo. Never returns the photo itself, and never a
 * long-lived link — a fresh URL is minted on every call (see
 * object-storage-s3.ts's DOWNLOAD_URL_TTL_SECONDS), so nothing durable
 * this route returns could be bookmarked or shared onward and keep
 * working after it expires.
 *
 * Same viewer scoping as the attendance list itself (GET .../attendance):
 * a person can always view their OWN photos; MANAGE_STAFF is required to
 * view anyone else's — deliberately not a stricter permission than what
 * already governs seeing someone else's clock-in/out timestamps, since a
 * photo is evidence for exactly that same timestamp.
 *
 * Phase 17 — gated behind FEATURES.STAFF_ATTENDANCE (part of the advanced
 * selfie-verification suite, not the free clock-in/clock-out baseline).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; recordId: string }> },
) {
  try {
    const { slug, recordId } = await ctx.params;
    const { session, restaurantId, role } = await resolveRestaurantContext(slug, undefined, {
      requireFeature: FEATURES.STAFF_ATTENDANCE,
    });

    if (!isObjectStorageConfigured()) {
      throw new HttpError("Selfie-verified attendance isn't available on this deployment yet.", 503);
    }

    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    if (kind !== "clock_in" && kind !== "clock_out") {
      throw new HttpError("kind must be clock_in or clock_out.", 400);
    }

    const [record] = await db
      .select({
        userId: attendanceRecords.userId,
        clockInPhotoObjectKey: attendanceRecords.clockInPhotoObjectKey,
        clockOutPhotoObjectKey: attendanceRecords.clockOutPhotoObjectKey,
      })
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.id, recordId), eq(attendanceRecords.restaurantId, restaurantId)))
      .limit(1);
    if (!record) {
      throw new HttpError("Attendance record not found.", 404);
    }

    if (record.userId !== session.user.id) {
      const canViewAll = await hasPermission(session.user.id, restaurantId, PERMISSIONS.MANAGE_STAFF, role);
      if (!canViewAll) {
        throw new HttpError("You can only view your own attendance photos.", 403);
      }
    }

    const key = kind === "clock_in" ? record.clockInPhotoObjectKey : record.clockOutPhotoObjectKey;
    if (!key) {
      throw new HttpError("No photo was captured for this shift event.", 404);
    }

    const { url: downloadUrl, expiresAt } = await createAttendancePhotoDownloadUrl(key);
    return NextResponse.json({ url: downloadUrl, expiresAt });
  } catch (err) {
    return toErrorResponse(err);
  }
}
