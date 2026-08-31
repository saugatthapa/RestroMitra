import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { setAnnouncementActiveSchema } from "@/lib/validation/system";
import { setAnnouncementActive, deleteAnnouncement } from "@/lib/system/announcements-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_ANNOUNCEMENTS);
    const { id } = await ctx.params;

    const parsed = await parseJsonBody(request, setAnnouncementActiveSchema);
    if (!parsed.ok) return parsed.response;

    const updated = await setAnnouncementActive(id, parsed.data.isActive);
    if (!updated) {
      return NextResponse.json({ error: "Announcement not found." }, { status: 404 });
    }

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: parsed.data.isActive ? "admin.announcement_activated" : "admin.announcement_deactivated",
      resourceType: "platform_announcement",
      resourceId: id,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_ANNOUNCEMENTS);
    const { id } = await ctx.params;

    const deleted = await deleteAnnouncement(id);
    if (!deleted) {
      return NextResponse.json({ error: "Announcement not found." }, { status: 404 });
    }

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "admin.announcement_deleted",
      resourceType: "platform_announcement",
      resourceId: id,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
