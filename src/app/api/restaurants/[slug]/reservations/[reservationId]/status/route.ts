import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { reservations } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateReservationStatusSchema } from "@/lib/validation/reservations";
import { canTransition, type ReservationStatus } from "@/lib/reservation-status";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { markTableSeated, releaseTableIfSoleReservation } from "@/lib/tables";

/**
 * Advances (or cancels) a reservation's status — the one place the
 * reservation lifecycle actually moves, same role as the order status
 * route. Every transition is checked against canTransition() so an
 * illegal jump (e.g. "requested" straight to "completed", or reopening a
 * "no_show") is rejected with a clear 400.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; reservationId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, reservationId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_RESERVATIONS,
    );

    const rows = await db
      .select()
      .from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.restaurantId, restaurantId)))
      .limit(1);
    const existing = rows[0];
    if (!existing) {
      return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
    }
    const currentStatus = existing.status as ReservationStatus;

    const parsed = await parseJsonBody(request, updateReservationStatusSchema);
    if (!parsed.ok) return parsed.response;
    const targetStatus = parsed.data.status;

    if (!canTransition(currentStatus, targetStatus)) {
      return NextResponse.json(
        {
          error: `Cannot move a reservation from "${currentStatus}" to "${targetStatus}".`,
        },
        { status: 400 },
      );
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(reservations)
        .set({ status: targetStatus, updatedAt: new Date() })
        .where(and(eq(reservations.id, reservationId), eq(reservations.restaurantId, restaurantId)))
        .returning();

      // Table-status effects of the transition — see markTableSeated and
      // releaseTableIfSoleReservation's own comments for exactly what each
      // does and doesn't override.
      if (row?.tableId) {
        if (targetStatus === "seated") {
          await markTableSeated(tx, row.tableId);
        } else if (targetStatus === "cancelled" || targetStatus === "no_show") {
          await releaseTableIfSoleReservation(tx, row.tableId, reservationId);
        }
      }

      return row;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "reservation.status_changed",
      resourceType: "reservation",
      resourceId: reservationId,
      ipAddress: getClientIp(request),
      metadata: { from: currentStatus, to: targetStatus },
    });

    return NextResponse.json({ reservation: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
