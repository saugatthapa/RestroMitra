import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { canManuallyTransition, type TableStatus } from "@/lib/table-status";
import { updateTableStatusSchema } from "@/lib/validation/tables";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * The ONLY route that moves a table between the handful of states staff
 * drive directly (opening a table to start an order, releasing one they
 * opened without ordering, finishing cleaning, marking a table broken and
 * back) — see canManuallyTransition() in src/lib/table-status.ts for
 * exactly which transitions are allowed here. Every other status (occupied,
 * payment_pending, cleaning-via-completion, reserved) is system-derived
 * from order/reservation activity (src/lib/tables.ts) and deliberately
 * NOT reachable through this endpoint, so the two mechanisms can't fight
 * each other.
 */
export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/tables/[tableId]/status">,
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, tableId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_TABLES,
    );

    const rows = await db
      .select()
      .from(restaurantTables)
      .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
      .limit(1);
    const existing = rows[0];
    if (!existing) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId);

    const parsed = await parseJsonBody(request, updateTableStatusSchema);
    if (!parsed.ok) return parsed.response;
    const targetStatus = parsed.data.status;
    const currentStatus = existing.status as TableStatus;

    if (!canManuallyTransition(currentStatus, targetStatus)) {
      return NextResponse.json(
        { error: `Cannot manually move a table from "${currentStatus}" to "${targetStatus}".` },
        { status: 400 },
      );
    }

    // Compare-and-swap, same reasoning as the order/reservation status
    // routes — two concurrent staff both opening the same table (or one
    // opening it while a system transition fires from an order event)
    // shouldn't both silently win.
    const [updated] = await db
      .update(restaurantTables)
      .set({ status: targetStatus, updatedAt: new Date() })
      .where(
        and(
          eq(restaurantTables.id, tableId),
          eq(restaurantTables.restaurantId, restaurantId),
          eq(restaurantTables.status, currentStatus),
        ),
      )
      .returning();

    if (!updated) {
      return NextResponse.json(
        {
          error: "This table's status was just changed by someone else. Please refresh and try again.",
        },
        { status: 409 },
      );
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "tables.status_changed",
      resourceType: "table",
      resourceId: tableId,
      ipAddress: getClientIp(request),
      metadata: { from: currentStatus, to: targetStatus },
    });

    return NextResponse.json({ table: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
