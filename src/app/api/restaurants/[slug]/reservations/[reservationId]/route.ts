import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { reservations } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateReservationSchema } from "@/lib/validation/reservations";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import {
  requireTableRowLock,
  assertPartyFitsCapacity,
  assertNoReservationOverlap,
  markTableReservedIfAvailable,
  releaseTableIfSoleReservation,
} from "@/lib/tables";

async function getOwnedReservation(restaurantId: string, reservationId: string) {
  const rows = await db
    .select()
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Edits booking details (party size, time, table assignment, notes, the
 * captured name/phone) — everything EXCEPT status, which goes through the
 * dedicated status sub-route so every status change is checked against
 * the reservation state machine (canTransition) rather than allowed as an
 * arbitrary field edit here.
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

    const existing = await getOwnedReservation(restaurantId, reservationId);
    if (!existing) {
      return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateReservationSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    // Effective post-edit values — whichever of table/time/duration/party
    // size the caller didn't touch keeps its existing value, since the
    // overlap/capacity re-check below has to validate the reservation's
    // FULL resulting booking window, not just whatever field changed.
    const effectiveTableId = data.tableId !== undefined ? data.tableId : existing.tableId;
    const effectiveReservationTime = data.reservationTime ?? existing.reservationTime;
    const effectiveDurationMinutes = data.durationMinutes ?? existing.durationMinutes;
    const effectivePartySize = data.partySize ?? existing.partySize;

    const bookingFieldsChanged =
      data.tableId !== undefined || data.reservationTime !== undefined || data.durationMinutes !== undefined;

    const updated = await db.transaction(async (tx) => {
      // Re-validate the booking window whenever the table, time, or
      // duration changes AND the edit still leaves the reservation
      // attached to a table — same lock-then-check pattern as creation, so
      // two concurrent edits (or an edit racing a fresh POST) can't both
      // pass the overlap check before either commits.
      if (effectiveTableId && bookingFieldsChanged) {
        const table = await requireTableRowLock(tx, restaurantId, effectiveTableId);
        assertPartyFitsCapacity(table.capacity, effectivePartySize);
        await assertNoReservationOverlap(tx, {
          restaurantId,
          tableId: effectiveTableId,
          reservationTime: effectiveReservationTime,
          durationMinutes: effectiveDurationMinutes,
          excludingReservationId: reservationId,
        });
      }

      const [row] = await tx
        .update(reservations)
        .set({
          ...(data.customerName !== undefined ? { customerName: data.customerName } : {}),
          ...(data.customerPhone !== undefined ? { customerPhone: data.customerPhone } : {}),
          ...(data.partySize !== undefined ? { partySize: data.partySize } : {}),
          ...(data.tableId !== undefined ? { tableId: data.tableId } : {}),
          ...(data.reservationTime !== undefined ? { reservationTime: data.reservationTime } : {}),
          ...(data.durationMinutes !== undefined ? { durationMinutes: data.durationMinutes } : {}),
          ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(reservations.id, reservationId), eq(reservations.restaurantId, restaurantId)))
        .returning();

      // Table-assignment change on a still-active (not yet seated/closed
      // out) reservation moves which table visually shows "reserved" —
      // release the old one (only if nothing else is still holding it) and
      // claim the new one (only if it's actually free right now).
      const oldTableId = existing.tableId;
      const newTableId = data.tableId !== undefined ? data.tableId : oldTableId;
      if (
        (existing.status === "requested" || existing.status === "confirmed") &&
        newTableId !== oldTableId
      ) {
        if (oldTableId) {
          await releaseTableIfSoleReservation(tx, oldTableId, reservationId, timezone);
        }
        if (newTableId) {
          await markTableReservedIfAvailable(tx, newTableId);
        }
      }

      return row;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "reservation.updated",
      resourceType: "reservation",
      resourceId: reservationId,
      ipAddress: getClientIp(request),
      metadata: { fields: Object.keys(data) },
    });

    return NextResponse.json({ reservation: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
