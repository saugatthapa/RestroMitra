import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { serviceCalls } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateServiceCallSchema } from "@/lib/validation/service-calls";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { publishEvent } from "@/lib/realtime";
import { HttpError } from "@/lib/http-error";

/**
 * The staff side of a service call's lifecycle: "acknowledge" (pending ->
 * acknowledged — the one-tap "on it" from the marketing copy) and "resolve"
 * (either status -> resolved — staff marks it done, whether or not they
 * separately acknowledged first). Same compare-and-swap-on-status pattern
 * as the order status route: the UPDATE's WHERE clause pins the expected
 * current status, so two staff members tapping "acknowledge" on the same
 * alert within the same second can't both "win" and both fire the
 * publishEvent below — the second request's UPDATE matches zero rows and
 * gets a 409 instead of double-notifying.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; callId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, callId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.VIEW_SERVICE_CALLS,
    );

    const parsed = await parseJsonBody(request, updateServiceCallSchema);
    if (!parsed.ok) return parsed.response;
    const { action } = parsed.data;

    const existing = await db.query.serviceCalls.findFirst({
      where: and(eq(serviceCalls.id, callId), eq(serviceCalls.restaurantId, restaurantId)),
    });
    if (!existing) {
      return NextResponse.json({ error: "Service call not found." }, { status: 404 });
    }

    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    if (action === "acknowledge" && existing.status !== "pending") {
      throw new HttpError(`Cannot acknowledge a call that is already "${existing.status}".`);
    }
    if (action === "resolve" && existing.status === "resolved") {
      throw new HttpError("This call has already been resolved.");
    }

    const targetStatus = action === "acknowledge" ? "acknowledged" : "resolved";
    const now = new Date();

    const [updated] = await db
      .update(serviceCalls)
      .set(
        action === "acknowledge"
          ? {
              status: "acknowledged",
              acknowledgedByUserId: session.user.id,
              acknowledgedAt: now,
              updatedAt: now,
            }
          : {
              status: "resolved",
              resolvedByUserId: session.user.id,
              resolvedAt: now,
              updatedAt: now,
            },
      )
      .where(
        and(
          eq(serviceCalls.id, callId),
          eq(serviceCalls.restaurantId, restaurantId),
          eq(serviceCalls.status, existing.status),
        ),
      )
      .returning();

    if (!updated) {
      throw new HttpError("This call was just updated by someone else. Please refresh.", 409);
    }

    await publishEvent(db, {
      restaurantId,
      branchId: updated.branchId,
      type: action === "acknowledge" ? "service_call.acknowledged" : "service_call.resolved",
      payload: {
        callId: updated.id,
        tableId: updated.tableId,
        status: updated.status,
        by: session.user.fullName,
      },
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: action === "acknowledge" ? "service_call.acknowledged" : "service_call.resolved",
      resourceType: "service_call",
      resourceId: callId,
      ipAddress: getClientIp(request),
      metadata: { tableId: updated.tableId, targetStatus },
    });

    return NextResponse.json({ call: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
