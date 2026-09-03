import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateVerificationContactSchema } from "@/lib/validation/system";
import { setVerificationContact } from "@/lib/system/verification-contact-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Updates the admin-editable WhatsApp/Instagram/TikTok contact details and
 * message shown on /verify-account (see verification-contact-db.ts). The
 * read side is bundled into GET /api/admin/system (same pattern as
 * maintenanceMode there) since /admin/system already loads both in one
 * fetch — this route is write-only.
 */
export async function PATCH(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SYSTEM);

    const parsed = await parseJsonBody(request, updateVerificationContactSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const instagramUrl = data.instagramUrl && data.instagramUrl.length > 0 ? data.instagramUrl : null;
    const tiktokUrl = data.tiktokUrl && data.tiktokUrl.length > 0 ? data.tiktokUrl : null;
    const whatsappNumber = data.whatsappNumber && data.whatsappNumber.length > 0 ? data.whatsappNumber : null;

    await setVerificationContact({
      instagramUrl,
      tiktokUrl,
      whatsappNumber,
      message: data.message,
      userId: session.user.id,
    });

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "admin.verification_contact_updated",
      resourceType: "platform_system",
      ipAddress: getClientIp(request),
      metadata: { instagramUrl, tiktokUrl, whatsappNumber },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
