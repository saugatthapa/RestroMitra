import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { leaveRequests } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { reviewLeaveRequestSchema } from "@/lib/validation/leave";
import { canReviewLeaveRequest } from "@/lib/leave";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * The owner/manager review call on a leave request: APPROVED or REJECTED
 * (reviewNote required on reject — same rule as attendance's status-review
 * route). MANAGE_STAFF-gated, branch-scoped the same way attendance's
 * correction/status routes are. Only a still-PENDING request can be
 * reviewed — see canReviewLeaveRequest's own comment for why this phase
 * doesn't support revisiting an already-decided one.
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
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
    );

    const [existing] = await db
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.id, requestId), eq(leaveRequests.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
    }
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });
    if (!canReviewLeaveRequest(existing.status)) {
      return NextResponse.json(
        { error: "Only a pending leave request can be reviewed." },
        { status: 400 },
      );
    }

    const parsed = await parseJsonBody(request, reviewLeaveRequestSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;
    const reviewNote = data.reviewNote && data.reviewNote.length > 0 ? data.reviewNote : null;

    const [record] = await db
      .update(leaveRequests)
      .set({
        status: data.status,
        reviewedByUserId: session.user.id,
        reviewedAt: new Date(),
        reviewNote,
      })
      .where(eq(leaveRequests.id, requestId))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "leave_request.reviewed",
      resourceType: "leave_request",
      resourceId: requestId,
      ipAddress: getClientIp(request),
      metadata: { from: existing.status, to: data.status, reviewNote },
    });

    return NextResponse.json({ record });
  } catch (err) {
    return toErrorResponse(err);
  }
}
