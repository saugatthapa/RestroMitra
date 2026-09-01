import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { reservations, customers, branches } from "@/db/schema";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createReservationSchema } from "@/lib/validation/reservations";
import { RESERVATION_STATUSES, type ReservationStatus } from "@/lib/reservation-status";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import {
  requireTableRowLock,
  assertPartyFitsCapacity,
  assertNoReservationOverlap,
  markTableReservedIfAvailable,
} from "@/lib/tables";
import { HttpError } from "@/lib/http-error";
import { restaurantDate, restaurantStartOfDay } from "@/lib/restaurant-date";

const RESERVATION_LIST_LIMIT = 300;

/**
 * Reservations are gated behind MANAGE_RESERVATIONS (manager/cashier/owner
 * by default — see DEFAULT_ROLE_PERMISSIONS) for both reads and writes,
 * same trust level as MANAGE_CUSTOMERS: front-desk data, not
 * profit-sensitive the way expenses/inventory are.
 *
 * `?date=YYYY-MM-DD` scopes the list to that single calendar day (the
 * natural unit for a reservation book — defaults to today when omitted);
 * `?status=` narrows further within that day.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_RESERVATIONS,
    );

    const url = new URL(request.url);
    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
    }

    const dateParam = url.searchParams.get("date");
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? dateParam
      : restaurantDate(timezone);
    const dayStart = restaurantStartOfDay(timezone, date);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const statusParam = url.searchParams.get("status");
    const status: ReservationStatus | null =
      statusParam && (RESERVATION_STATUSES as readonly string[]).includes(statusParam)
        ? (statusParam as ReservationStatus)
        : null;

    const rows = await db.query.reservations.findMany({
      where: (r, { and: dAnd, eq: dEq, gte: dGte, lt: dLt }) =>
        dAnd(
          dEq(r.restaurantId, restaurantId),
          dGte(r.reservationTime, dayStart),
          dLt(r.reservationTime, dayEnd),
          status ? dEq(r.status, status) : undefined,
          effectiveBranchId ? dEq(r.branchId, effectiveBranchId) : undefined,
        ),
      orderBy: (r, { asc: dAsc }) => [dAsc(r.reservationTime)],
      limit: RESERVATION_LIST_LIMIT,
      with: {
        table: { columns: { id: true, name: true } },
      },
    });

    return NextResponse.json({ reservations: rows, date });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_RESERVATIONS,
    );

    const parsed = await parseJsonBody(request, createReservationSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    // Same "resolve, don't trust" pattern as tableId/customerId elsewhere:
    // an id supplied by the client is only used once it's confirmed to
    // belong to this restaurant.
    let customerId: string | null = null;
    if (data.customerId) {
      const rows = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, data.customerId), eq(customers.restaurantId, restaurantId)))
        .limit(1);
      if (rows.length === 0) {
        return NextResponse.json({ error: "Customer not found." }, { status: 404 });
      }
      customerId = rows[0].id;
    }

    // Table resolution + the double-booking check + the insert all happen
    // inside one transaction, with the table row locked for its duration
    // (requireTableRowLock) — otherwise two concurrent requests for the
    // same table/overlapping time could both pass assertNoReservationOverlap
    // before either commits. Branch (no-table) reservations skip the lock
    // entirely since there's no table row to race on.
    const durationMinutes = data.durationMinutes ?? 90;
    const reservation = await db.transaction(async (tx) => {
      let tableId: string | null = null;
      let branchId: string | null = null;

      if (data.tableId) {
        const table = await requireTableRowLock(tx, restaurantId, data.tableId);
        tableId = table.id;
        branchId = table.branchId;
        assertPartyFitsCapacity(table.capacity, data.partySize);
        await assertNoReservationOverlap(tx, {
          restaurantId,
          tableId,
          reservationTime: data.reservationTime,
          durationMinutes,
        });
      } else if (data.branchId) {
        const rows = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.id, data.branchId), eq(branches.restaurantId, restaurantId)))
          .limit(1);
        if (rows.length === 0) {
          throw new HttpError("Branch not found.", 404);
        }
        branchId = rows[0].id;
      } else {
        // No table and no explicit branch: a branch-scoped caller's own
        // branch, or null (genuinely unscoped — fine, since a reservation
        // with neither a table nor a branch is legitimately ambiguous until
        // staff confirm one) for an unrestricted caller.
        branchId = grantedBranchId ?? null;
      }
      if (branchId) {
        await requireBranchAccess(session.user.id, restaurantId, branchId, {
          role,
          branchId: grantedBranchId,
        });
      }

      const [inserted] = await tx
        .insert(reservations)
        .values({
          restaurantId,
          customerId,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          partySize: data.partySize,
          tableId,
          branchId,
          reservationTime: data.reservationTime,
          durationMinutes,
          notes: data.notes || null,
          createdByUserId: session.user.id,
        })
        .returning();

      if (tableId) {
        await markTableReservedIfAvailable(tx, tableId);
      }

      return inserted;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      branchId: reservation.branchId,
      action: "reservation.created",
      resourceType: "reservation",
      resourceId: reservation.id,
      ipAddress: getClientIp(request),
      metadata: { partySize: reservation.partySize, reservationTime: reservation.reservationTime },
    });

    return NextResponse.json({ reservation }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
