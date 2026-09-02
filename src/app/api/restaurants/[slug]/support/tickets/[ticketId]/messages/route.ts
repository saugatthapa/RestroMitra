import { NextResponse } from "next/server";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { addSupportTicketMessageSchema } from "@/lib/validation/support";
import { getSupportTicketForRestaurant, addSupportTicketMessage } from "@/lib/support/tickets-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * A tenant staff member replying on their own ticket's thread. Ownership
 * is checked first via getSupportTicketForRestaurant (id + restaurantId
 * together) before touching support_ticket_messages at all — that table
 * has no restaurantId column of its own, so this ticket-ownership check
 * IS the tenant-isolation boundary for every reply.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; ticketId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, ticketId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug);

    const ticket = await getSupportTicketForRestaurant(ticketId, restaurantId);
    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, addSupportTicketMessageSchema);
    if (!parsed.ok) return parsed.response;

    const created = await addSupportTicketMessage({
      ticketId,
      authorUserId: session.user.id,
      isFromPlatform: false,
      body: parsed.data.body,
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "support_ticket.replied",
      resourceType: "support_ticket",
      resourceId: ticketId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
