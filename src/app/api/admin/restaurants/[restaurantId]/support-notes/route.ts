import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { addSupportNoteSchema } from "@/lib/validation/support";
import { addSupportNote } from "@/lib/support/notes-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Platform Control Center (Phase 9) — internal support notes on a tenant.
 * Gated on MANAGE_SUPPORT (its catalog description already covers
 * "internal notes" — see platform-permissions.ts). Never surfaced to the
 * tenant itself; purely a support-team memory aid on /admin.
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

    const parsed = await parseJsonBody(request, addSupportNoteSchema);
    if (!parsed.ok) return parsed.response;

    const created = await addSupportNote({
      restaurantId,
      authorUserId: session.user.id,
      note: parsed.data.note,
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "admin.support_note_added",
      resourceType: "restaurant_support_note",
      resourceId: created.id,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
