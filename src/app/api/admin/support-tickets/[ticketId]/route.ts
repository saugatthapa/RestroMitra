import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateSupportTicketStatusSchema } from "@/lib/validation/support";
import {
  getSupportTicketAdmin,
  listSupportTicketMessages,
  updateSupportTicketStatus,
} from "@/lib/support/tickets-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** A ticket's full thread, admin-side — unscoped by restaurant (a platform admin can view any tenant's ticket). */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ ticketId: string }> },
) {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);
    const { ticketId } = await ctx.params;

    const ticket = await getSupportTicketAdmin(ticketId);
    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    }

    const messages = await listSupportTicketMessages(ticketId);
    return NextResponse.json({ ticket, messages });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Admin-only status transition (open/in_progress/resolved/closed). */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ ticketId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);
    const { ticketId } = await ctx.params;

    const parsed = await parseJsonBody(request, updateSupportTicketStatusSchema);
    if (!parsed.ok) return parsed.response;

    const updated = await updateSupportTicketStatus(ticketId, parsed.data.status);
    if (!updated) {
      return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    }

    await recordAuditLog({
      restaurantId: updated.restaurantId,
      userId: session.user.id,
      action: "admin.support_ticket_status_changed",
      resourceType: "support_ticket",
      resourceId: ticketId,
      ipAddress: getClientIp(request),
      metadata: { status: parsed.data.status },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
