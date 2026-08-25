import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateTableSchema } from "@/lib/validation/tables";
import { getTodayUpcomingReservationsByTable } from "@/lib/tables";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccess } from "@/lib/rbac/guard";

async function getOwnedTable(restaurantId: string, tableId: string) {
  const rows = await db
    .select()
    .from(restaurantTables)
    .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Table detail — the floor plan's "click a table" panel. Returns the table
 * row itself, its currently active (not completed/cancelled) orders so
 * staff can see what's actually happening at this table right now, and
 * today's upcoming reservations holding it. Any staff member with
 * restaurant access can view (same read/write split as tables GET), no
 * extra permission beyond ordinary session access.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; tableId: string }> },
) {
  try {
    const { slug, tableId } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug);

    const existing = await getOwnedTable(restaurantId, tableId);
    if (!existing) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }

    const activeOrders = await db.query.orders.findMany({
      where: (o, { and: qAnd, eq: qEq, sql: qSql }) =>
        qAnd(qEq(o.tableId, tableId), qSql`${o.status} not in ('completed','cancelled')`),
      orderBy: (o, { asc }) => [asc(o.placedAt)],
      columns: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        totalInPaisa: true,
        customerName: true,
        placedAt: true,
        // Commercial Launch Phase B.7 — Table Operations, so the floor
        // plan's table detail panel can show/toggle hold state per order.
        isOnHold: true,
        holdReason: true,
      },
    });

    const reservationsByTable = await getTodayUpcomingReservationsByTable(restaurantId, [tableId], timezone);

    return NextResponse.json({
      table: existing,
      activeOrders,
      upcomingReservations: reservationsByTable.get(tableId) ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; tableId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, tableId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_TABLES,
    );

    const existing = await getOwnedTable(restaurantId, tableId);
    if (!existing) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const parsed = await parseJsonBody(request, updateTableSchema);
    if (!parsed.ok) return parsed.response;
    if (Object.keys(parsed.data).length === 0) {
      return NextResponse.json({ error: "No changes provided." }, { status: 400 });
    }

    const [updated] = await db
      .update(restaurantTables)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "tables.updated",
      resourceType: "table",
      resourceId: tableId,
      ipAddress: getClientIp(request),
      metadata: parsed.data,
    });

    return NextResponse.json({ table: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ slug: string; tableId: string }> },
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

    const existing = await getOwnedTable(restaurantId, tableId);
    if (!existing) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }

    // Soft delete: the table's QR code may already be printed and taped to
    // a physical table. Deactivating (not deleting) means a customer who
    // scans an old code gets a clean "this table is no longer active"
    // message from the public order page instead of a broken link, and any
    // past orders tied to this table keep resolving.
    const [updated] = await db
      .update(restaurantTables)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "tables.deactivated",
      resourceType: "table",
      resourceId: tableId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ table: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
