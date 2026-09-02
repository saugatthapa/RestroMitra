import { NextResponse } from "next/server";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getSupportTicketForRestaurant, listSupportTicketMessages } from "@/lib/support/tickets-db";

/**
 * A ticket's full thread, tenant-side. `getSupportTicketForRestaurant`
 * scopes on (id, restaurantId) together — see its own doc comment — so a
 * staff member at restaurant A can never read (or, via the sibling
 * messages route, reply to) a ticket that belongs to restaurant B just by
 * guessing its id.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; ticketId: string }> },
) {
  try {
    const { slug, ticketId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const ticket = await getSupportTicketForRestaurant(ticketId, restaurantId);
    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    }

    const messages = await listSupportTicketMessages(ticketId);
    return NextResponse.json({ ticket, messages });
  } catch (err) {
    return toErrorResponse(err);
  }
}
