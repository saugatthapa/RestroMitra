import { NextResponse } from "next/server";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { FEATURES } from "@/lib/feature-catalog";
import { acceptAttendancePhotoConsentSchema } from "@/lib/validation/attendance-photo";
import { CURRENT_CONSENT_VERSION, CONSENT_NOTICE_TITLE, CONSENT_NOTICE_TEXT } from "@/lib/attendance-consent";
import { getLatestConsent, hasCurrentConsentForUser, recordConsent } from "@/lib/attendance-photos-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Phase 12 (Attendance overhaul, Track B) — the calling user's own consent
 * status for selfie capture at THIS restaurant, plus the current notice
 * text/version to show. Self-service only, same scoping as clock-in/out.
 *
 * Phase 17 — gated behind FEATURES.STAFF_ATTENDANCE, part of the advanced
 * (selfie-verification) suite, not the free clock-in/clock-out baseline.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, undefined, {
      requireFeature: FEATURES.STAFF_ATTENDANCE,
    });

    const latest = await getLatestConsent(session.user.id, restaurantId);

    return NextResponse.json({
      hasCurrentConsent: latest?.consentVersion === CURRENT_CONSENT_VERSION,
      noticeVersion: CURRENT_CONSENT_VERSION,
      noticeTitle: CONSENT_NOTICE_TITLE,
      noticeText: CONSENT_NOTICE_TEXT,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Records the calling user's consent to the CURRENT notice version.
 * Append-only (see schema.ts's own comment on attendance_photo_consents)
 * — calling this again (e.g. after the notice text changes) simply adds
 * another row, never edits the earlier one.
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

    const parsed = await parseJsonBody(request, acceptAttendancePhotoConsentSchema);
    if (!parsed.ok) return parsed.response;

    const alreadyCurrent = await hasCurrentConsentForUser(session.user.id, restaurantId);
    if (alreadyCurrent) {
      // Not an error — a double-submit (double-tap, page refresh mid-flow)
      // should just confirm the existing state, not pile up a duplicate
      // ledger row for the identical version.
      return NextResponse.json({ hasCurrentConsent: true, noticeVersion: CURRENT_CONSENT_VERSION });
    }

    await recordConsent({
      userId: session.user.id,
      restaurantId,
      ipAddress: getClientIp(request),
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "attendance.photo_consent_recorded",
      resourceType: "user",
      resourceId: session.user.id,
      ipAddress: getClientIp(request),
      metadata: { consentVersion: CURRENT_CONSENT_VERSION },
    });

    return NextResponse.json({ hasCurrentConsent: true, noticeVersion: CURRENT_CONSENT_VERSION }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
