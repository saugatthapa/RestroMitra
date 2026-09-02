import { NextResponse } from "next/server";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createSupportTicketSchema } from "@/lib/validation/support";
import {
  createSupportTicket,
  listSupportTicketsForRestaurant,
  type SupportTicketStatus,
} from "@/lib/support/tickets-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const VALID_STATUSES: SupportTicketStatus[] = ["open", "in_progress", "resolved", "closed"];

/**
 * Gap audit P1 — restaurant-owner-facing support tickets. Unlike the
 * admin-authored restaurant_support_notes tooling (never surfaced to a
 * tenant), this is the tenant's own side of the conversation: any staff
 * member with an active role grant on this restaurant can file and read
 * tickets — deliberately no `permission` argument to resolveRestaurantContext,
 * the same "any authenticated staff member, no finer RBAC gate" tier as
 * push-subscriptions (see that route's own comment) rather than an
 * owner/manager-only feature like Staff or Settings.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && (VALID_STATUSES as string[]).includes(statusParam)
        ? (statusParam as SupportTicketStatus)
        : undefined;

    const tickets = await listSupportTicketsForRestaurant(restaurantId, { status });
    return NextResponse.json({ tickets });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug);

    const parsed = await parseJsonBody(request, createSupportTicketSchema);
    if (!parsed.ok) return parsed.response;

    const created = await createSupportTicket({
      restaurantId,
      createdByUserId: session.user.id,
      subject: parsed.data.subject,
      body: parsed.data.body,
      priority: parsed.data.priority,
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "support_ticket.created",
      resourceType: "support_ticket",
      resourceId: created.id,
      ipAddress: getClientIp(request),
      metadata: { subject: parsed.data.subject },
    });

    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
