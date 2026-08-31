import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { removeSupportTag } from "@/lib/support/tags-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string; tagId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);
    const { restaurantId, tagId } = await ctx.params;

    const removed = await removeSupportTag(tagId, restaurantId);
    if (!removed) {
      return NextResponse.json({ error: "Tag not found." }, { status: 404 });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "admin.support_tag_removed",
      resourceType: "restaurant_support_tag",
      resourceId: tagId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
