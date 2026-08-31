import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { FEATURES } from "@/lib/feature-catalog";
import { updateAttendanceSettingsSchema } from "@/lib/validation/attendance-photo";
import { isObjectStorageConfigured } from "@/lib/storage/object-storage-s3";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Phase 12 (Attendance overhaul, Track B) — the owner-facing toggle for
 * requiring a selfie at clock-in/out. Its own tiny route, same "no general
 * restaurant-profile endpoint exists yet" reasoning as kot-settings/
 * route.ts, which this deliberately mirrors.
 *
 * Deliberately NOT feature-gated (unlike the PATCH below) — the
 * AttendanceTab loads this in the same Promise.all as the basic (ungated)
 * attendance list, and a 403 here would fail that whole load for every
 * plan, hiding the free clock-in/clock-out UI along with it. Reading
 * "is selfie capture on, and is it even available on this deployment" is
 * harmless regardless of plan; only actually turning it on is the premium
 * action (see Phase 17's own comment on the PATCH handler).
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const [row] = await db
      .select({ selfieClockInRequired: restaurants.selfieClockInRequired })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    return NextResponse.json({
      selfieClockInRequired: row?.selfieClockInRequired ?? false,
      objectStorageConfigured: isObjectStorageConfigured(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Gated MANAGE_RESTAURANT_SETTINGS — owner-only by default, same
 * "structural configuration" trust tier as kot-settings/branches/
 * subscription. Refuses to turn the requirement ON when object storage
 * isn't configured on this deployment — there would be nowhere to
 * actually store the photos the toggle then demands.
 *
 * Phase 17 — also requires FEATURES.STAFF_ATTENDANCE: turning selfie
 * capture ON is the entry point into the whole gated advanced-attendance
 * suite (photo verification, review, the works), so this is where a
 * Starter-plan restaurant hits the plan-gate wall, not the free
 * clock-in/clock-out routes themselves.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_RESTAURANT_SETTINGS,
      { requireFeature: FEATURES.STAFF_ATTENDANCE },
    );

    const parsed = await parseJsonBody(request, updateAttendanceSettingsSchema);
    if (!parsed.ok) return parsed.response;

    if (parsed.data.selfieClockInRequired && !isObjectStorageConfigured()) {
      return NextResponse.json(
        { error: "Selfie-verified attendance isn't available on this deployment yet — object storage isn't configured." },
        { status: 400 },
      );
    }

    const [updated] = await db
      .update(restaurants)
      .set({ selfieClockInRequired: parsed.data.selfieClockInRequired, updatedAt: new Date() })
      .where(eq(restaurants.id, restaurantId))
      .returning({ selfieClockInRequired: restaurants.selfieClockInRequired });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "restaurant.attendance_settings_updated",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: { selfieClockInRequired: parsed.data.selfieClockInRequired },
    });

    return NextResponse.json({
      selfieClockInRequired: updated?.selfieClockInRequired ?? false,
      objectStorageConfigured: isObjectStorageConfigured(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
