import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { FEATURES } from "@/lib/feature-catalog";
import { requestPhotoUploadUrlSchema } from "@/lib/validation/attendance-photo";
import { buildAttendancePhotoKey } from "@/lib/storage/attendance-photo-key";
import { isObjectStorageConfigured, createAttendancePhotoUploadUrl } from "@/lib/storage/object-storage-s3";
import { hasCurrentConsentForUser } from "@/lib/attendance-photos-db";
import { hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Phase 12 (Attendance overhaul, Track B) — mints a presigned PUT URL the
 * browser uploads a selfie to directly (this server never sees the photo
 * bytes). Self-service only: always for the CALLING user's own upcoming
 * clock-in/out, same "this is about the caller's own shift" scoping as the
 * clock-in/out routes themselves — no permission beyond restaurant
 * membership, and no way to request a key for anyone else.
 *
 * Requires current consent on file (see attendance-consent.ts) — a client
 * that hasn't gone through the consent dialog gets a 403 telling it so,
 * rather than a URL it could use to upload a photo nobody agreed to.
 *
 * Rate limited per user — a presigned-URL mint is cheap for this server
 * but each one is a live invitation to write to the bucket; capping how
 * many a single account can request in a window bounds worst-case storage
 * abuse from a compromised or buggy client.
 *
 * Phase 17 — gated behind FEATURES.STAFF_ATTENDANCE, closing the API-level
 * loophole even though the client never surfaces this flow to a
 * non-entitled restaurant (selfieClockInRequired can never be turned on
 * for them either — see the settings PATCH route).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, undefined, {
      requireFeature: FEATURES.STAFF_ATTENDANCE,
    });

    if (!isObjectStorageConfigured()) {
      return NextResponse.json(
        { error: "Selfie-verified attendance isn't available on this deployment yet." },
        { status: 503 },
      );
    }

    const parsed = await parseJsonBody(request, requestPhotoUploadUrlSchema);
    if (!parsed.ok) return parsed.response;

    const limit = rateLimit(`attendance-photo-upload-url:user:${session.user.id}`, {
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many photo upload requests in a short time. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const consented = await hasCurrentConsentForUser(session.user.id, restaurantId);
    if (!consented) {
      return NextResponse.json(
        { error: "You need to accept the selfie-capture consent notice first." },
        { status: 403 },
      );
    }

    const key = buildAttendancePhotoKey({
      restaurantId,
      userId: session.user.id,
      kind: parsed.data.kind,
      token: randomBytes(18).toString("base64url"),
    });
    const { url, expiresAt } = await createAttendancePhotoUploadUrl(key);

    return NextResponse.json({ uploadUrl: url, key, expiresAt, contentType: "image/jpeg" });
  } catch (err) {
    return toErrorResponse(err);
  }
}
