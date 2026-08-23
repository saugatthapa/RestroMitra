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
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
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

    // RC audit P1 fix — the UPDATE's WHERE clause includes
    // `status = currentStatus`, a compare-and-swap on the status column,
    // matching the pattern every other status-transition route in this
    // codebase already uses (orders, tables, service-calls). Without it,
    // two staff concurrently PATCHing the same `confirmed` reservation —
    // one to `seated`, one to `cancelled` — would both read the same stale
    // status outside this transaction, both pass canTransition, and both
    // UPDATEs would match and commit: whichever runs last silently
    // overwrites the other, desyncing the floor plan from reality (e.g. a
    // seated party's table gets released as "available"). With the extra
    // condition, Postgres serializes the two UPDATEs; the second one's
    // WHERE clause no longer matches once the first has committed, so it
    // returns zero rows and this route reports a conflict instead of
    // silently clobbering the other request's transition.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(reservations)
        .set({ status: targetStatus, updatedAt: new Date() })
        .where(
          and(
            eq(reservations.id, reservationId),
            eq(reservations.restaurantId, restaurantId),
            eq(reservations.status, currentStatus),
          ),
        )
        .returning();

      if (!row) return null;

      // Table-status effects of the transition — see markTableSeated and
      // releaseTableIfSoleReservation's own comments for exactly what each
      // does and doesn't override.
      if (row.tableId) {
        if (targetStatus === "seated") {
          await markTableSeated(tx, row.tableId);
        } else if (targetStatus === "cancelled" || targetStatus === "no_show") {
          await releaseTableIfSoleReservation(tx, row.tableId, reservationId, timezone);
        }
      }

      return row;
    });

    if (!updated) {
      return NextResponse.json(
        {
          error:
            "This reservation's status was just changed by someone else. Please refresh and try again.",
        },
        { status: 409 },
      );
    }

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
