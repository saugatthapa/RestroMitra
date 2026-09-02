import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { listAllSupportTickets, type SupportTicketStatus } from "@/lib/support/tickets-db";

const VALID_STATUSES: SupportTicketStatus[] = ["open", "in_progress", "resolved", "closed"];

/**
 * Platform Control Center — the admin queue for tenant-filed support
 * tickets (Gap audit P1). Gated on MANAGE_SUPPORT, the same trust tier as
 * the existing internal-notes/tags tooling (support_admin holds it by
 * default — see platform-permissions.ts). `?status=`/`?restaurantId=`
 * narrow the queue; `?limit=`/`?offset=` page it, same pattern as the
 * platform audit log.
 */
export async function GET(request: Request) {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && (VALID_STATUSES as string[]).includes(statusParam)
        ? (statusParam as SupportTicketStatus)
        : undefined;

    const result = await listAllSupportTickets({
      status,
      restaurantId: url.searchParams.get("restaurantId") ?? undefined,
      limit: Number(url.searchParams.get("limit")) || undefined,
      offset: Number(url.searchParams.get("offset")) || undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
