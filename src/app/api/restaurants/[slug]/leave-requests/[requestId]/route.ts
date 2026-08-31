import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { leaveRequests } from "@/db/schema";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { FEATURES } from "@/lib/feature-catalog";
import { canCancelLeaveRequest } from "@/lib/leave";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Self-service cancellation of the CALLER'S OWN still-pending leave
 * request — no MANAGE_STAFF needed, mirroring the create route's trust
 * tier. Deliberately does NOT let a manager cancel someone else's request
 * on their behalf, and does NOT let anyone cancel an already-approved/
 * rejected one (a decided request is a closed record — same "no
 * reopening" restraint as attendance corrections never clearing
 * clockOutAt back to null). A manager who wants to reverse an approved
 * leave has to say so via a fresh review call... which this phase doesn't
 * support either (canReviewLeaveRequest also requires "pending") — a
 * genuine gap, deferred rather than hastily bolted on here.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; requestId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, requestId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, undefined, {
      requireFeature: FEATURES.STAFF_ATTENDANCE,
    });

    const [existing] = await db
      .select()
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.id, requestId),
          eq(leaveRequests.restaurantId, restaurantId),
          eq(leaveRequests.userId, session.user.id),
        ),
      )
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
    }
    if (!canCancelLeaveRequest(existing.status)) {
      return NextResponse.json(
        { error: "Only a pending leave request can be cancelled." },
        { status: 400 },
      );
    }

    const [record] = await db
      .update(leaveRequests)
      .set({ status: "cancelled" })
      .where(eq(leaveRequests.id, requestId))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "leave_request.cancelled",
      resourceType: "leave_request",
      resourceId: requestId,
      ipAddress: getClientIp(request),
      metadata: {},
    });

    return NextResponse.json({ record });
  } catch (err) {
    return toErrorResponse(err);
  }
}
