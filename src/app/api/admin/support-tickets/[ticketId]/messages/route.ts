import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { addSupportTicketMessageSchema } from "@/lib/validation/support";
import { getSupportTicketAdmin, addSupportTicketMessage } from "@/lib/support/tickets-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** A platform admin replying on a tenant's ticket thread — flagged isFromPlatform so the tenant-side UI renders it as a support reply. */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ ticketId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);
    const { ticketId } = await ctx.params;

    const ticket = await getSupportTicketAdmin(ticketId);
    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, addSupportTicketMessageSchema);
    if (!parsed.ok) return parsed.response;

    const created = await addSupportTicketMessage({
      ticketId,
      authorUserId: session.user.id,
      isFromPlatform: true,
      body: parsed.data.body,
    });

    await recordAuditLog({
      restaurantId: ticket.restaurantId,
      userId: session.user.id,
      action: "admin.support_ticket_replied",
      resourceType: "support_ticket",
      resourceId: ticketId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
