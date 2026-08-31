import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { deleteSupportNote } from "@/lib/support/notes-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string; noteId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);
    const { restaurantId, noteId } = await ctx.params;

    const deleted = await deleteSupportNote(noteId, restaurantId);
    if (!deleted) {
      return NextResponse.json({ error: "Note not found." }, { status: 404 });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "admin.support_note_removed",
      resourceType: "restaurant_support_note",
      resourceId: noteId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
