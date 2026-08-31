import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { leaveRequests, users } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { hasPermission, requireBranchAccess } from "@/lib/rbac/guard";
import { FEATURES } from "@/lib/feature-catalog";
import { createLeaveRequestSchema } from "@/lib/validation/leave";
import { leaveRangesOverlap } from "@/lib/leave";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const reviewers = alias(users, "reviewers");

/**
 * Same scope rule as attendance's GET route: no permission gate beyond
 * ordinary restaurant membership — everyone can see leave requests, but
 * only someone holding MANAGE_STAFF sees the whole restaurant's; anyone
 * else only sees their own.
 *
 * Phase 17 — the whole leave-requests feature is part of the advanced
 * (gated) attendance suite, unlike plain attendance clock-in/clock-out
 * itself, which stays free — see FEATURES.STAFF_ATTENDANCE's own comment.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(slug, undefined, {
      requireFeature: FEATURES.STAFF_ATTENDANCE,
    });

    const canViewAll = await hasPermission(session.user.id, restaurantId, PERMISSIONS.MANAGE_STAFF, role);

    const url = new URL(request.url);
    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
    }

    const rows = await db
      .select({
        id: leaveRequests.id,
        userId: leaveRequests.userId,
        fullName: users.fullName,
        branchId: leaveRequests.branchId,
        leaveType: leaveRequests.leaveType,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        reason: leaveRequests.reason,
        status: leaveRequests.status,
        reviewedAt: leaveRequests.reviewedAt,
        reviewNote: leaveRequests.reviewNote,
        reviewedByName: reviewers.fullName,
        createdAt: leaveRequests.createdAt,
      })
      .from(leaveRequests)
      .innerJoin(users, eq(leaveRequests.userId, users.id))
      .leftJoin(reviewers, eq(leaveRequests.reviewedByUserId, reviewers.id))
      .where(
        and(
          eq(leaveRequests.restaurantId, restaurantId),
          canViewAll ? undefined : eq(leaveRequests.userId, session.user.id),
          effectiveBranchId ? eq(leaveRequests.branchId, effectiveBranchId) : undefined,
        ),
      )
      .orderBy(desc(leaveRequests.createdAt))
      .limit(200);

    return NextResponse.json({ requests: rows, canViewAll });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Self-service creation — same "about the caller's own record, no extra
 * permission required" trust tier as attendance clock-in/out. Refuses a
 * request that overlaps one of the caller's own still-live (pending or
 * approved) requests, so the same days can't be requested twice over.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, branchId } = await resolveRestaurantContext(slug, undefined, {
      requireFeature: FEATURES.STAFF_ATTENDANCE,
    });

    const parsed = await parseJsonBody(request, createLeaveRequestSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const existing = await db
      .select({ startDate: leaveRequests.startDate, endDate: leaveRequests.endDate })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.restaurantId, restaurantId),
          eq(leaveRequests.userId, session.user.id),
          inArray(leaveRequests.status, ["pending", "approved"]),
          // Coarse DB-side window (a full overlap check needs the exact
          // comparison leaveRangesOverlap does) — just narrows the rows
          // worth checking in JS below.
          gte(leaveRequests.endDate, data.startDate),
          lte(leaveRequests.startDate, data.endDate),
        ),
      );

    const conflict = existing.some((r) => leaveRangesOverlap(r.startDate, r.endDate, data.startDate, data.endDate));
    if (conflict) {
      return NextResponse.json(
        { error: "You already have a pending or approved leave request that overlaps these dates." },
        { status: 409 },
      );
    }

    const [record] = await db
      .insert(leaveRequests)
      .values({
        restaurantId,
        userId: session.user.id,
        branchId,
        leaveType: data.leaveType,
        startDate: data.startDate,
        endDate: data.endDate,
        reason: data.reason || null,
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "leave_request.created",
      resourceType: "leave_request",
      resourceId: record.id,
      ipAddress: getClientIp(request),
      metadata: { leaveType: data.leaveType, startDate: data.startDate, endDate: data.endDate },
    });

    return NextResponse.json({ record }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
