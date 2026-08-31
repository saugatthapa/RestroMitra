import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { addSupportTagSchema } from "@/lib/validation/support";
import { addSupportTag } from "@/lib/support/tags-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Platform Control Center (Phase 9) — attaches one of the fixed catalog
 * support-status tags (see support/tags.ts) to a tenant. Gated on
 * MANAGE_SUPPORT, same as support notes and session revocation below.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);
    const { restaurantId } = await ctx.params;

    const parsed = await parseJsonBody(request, addSupportTagSchema);
    if (!parsed.ok) return parsed.response;

    await addSupportTag({
      restaurantId,
      addedByUserId: session.user.id,
      tag: parsed.data.tag,
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "admin.support_tag_added",
      resourceType: "restaurant_support_tag",
      ipAddress: getClientIp(request),
      metadata: { tag: parsed.data.tag },
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
