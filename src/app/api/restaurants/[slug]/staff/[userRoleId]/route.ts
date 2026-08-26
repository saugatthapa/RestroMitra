import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, branches } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateStaffSchema } from "@/lib/validation/staff";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";

async function getOwnedGrant(restaurantId: string, userRoleId: string) {
  const rows = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.id, userRoleId), eq(userRoles.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Changes a staff member's role and/or active status. Two things this
 * route deliberately refuses, both fail-closed:
 *  - Touching an "owner" grant — ownership isn't reassigned or revoked
 *    through this flow (see staff-roles.ts's comment on ASSIGNABLE_STAFF_ROLES).
 *  - A caller deactivating their OWN grant — a manager holding
 *    MANAGE_STAFF could otherwise lock themselves out with no one left to
 *    undo it (unlike the owner, who's protected structurally, a manager
 *    has no such backstop).
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; userRoleId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, userRoleId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
    );

    const existing = await getOwnedGrant(restaurantId, userRoleId);
    if (!existing) {
      return NextResponse.json({ error: "Staff member not found." }, { status: 404 });
    }
    // QA hardening pass — a branch-scoped manager must not be able to
    // change the role/status/branch of staff outside their own branch (or
    // of a restaurant-wide grant, which isn't "theirs" to manage either).
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });
    if (existing.role === "owner" || existing.role === "platform_admin") {
      return NextResponse.json(
        { error: "The restaurant owner's access can't be changed here." },
        { status: 400 },
      );
    }
    if (existing.userId === session.user.id && existing.isActive) {
      return NextResponse.json(
        { error: "You can't deactivate your own staff access." },
        { status: 400 },
      );
    }

    const parsed = await parseJsonBody(request, updateStaffSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    // Reactivating a previously-deactivated grant needs the same "at most
    // one active grant per user per restaurant" check the staff-add route
    // does on create — otherwise reactivating grant A while this same
    // user already holds a separate active grant B here (e.g. removed as
    // waiter@BranchA, re-added as manager@BranchB, then the old
    // waiter@BranchA row gets reactivated too) would silently leave two
    // active roles for one person, which the rest of this app (a single
    // requireRestaurantAccess row, the dashboard's role display) isn't
    // built to handle. See user_roles_one_active_per_restaurant_unique in
    // schema.ts for the DB-level backstop this mirrors.
    if (data.isActive === true && !existing.isActive) {
      const conflicting = await db
        .select({ id: userRoles.id })
        .from(userRoles)
        .where(
          and(
            eq(userRoles.userId, existing.userId),
            eq(userRoles.restaurantId, restaurantId),
            eq(userRoles.isActive, true),
          ),
        )
        .limit(1);
      if (conflicting.length > 0) {
        return NextResponse.json(
          {
            error:
              "This person already has a separate active role at this restaurant. Deactivate that one first.",
          },
          { status: 409 },
        );
      }
    }

    // Reassigning to a specific branch (or back to unrestricted, via an
    // explicit null) — same "resolve, don't trust" verification as the
    // create path.
    let branchId: string | null | undefined;
    if (data.branchId !== undefined) {
      if (data.branchId === null) {
        branchId = null;
      } else {
        const branchRows = await db
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.id, data.branchId), eq(branches.restaurantId, restaurantId)))
          .limit(1);
        if (branchRows.length === 0) {
          return NextResponse.json({ error: "Branch not found." }, { status: 404 });
        }
        branchId = branchRows[0].id;
      }
    }

    const [updated] = await db
      .update(userRoles)
      .set({
        ...(data.role !== undefined ? { role: data.role } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(branchId !== undefined ? { branchId } : {}),
      })
      .where(and(eq(userRoles.id, userRoleId), eq(userRoles.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "staff.updated",
      resourceType: "user_role",
      resourceId: userRoleId,
      ipAddress: getClientIp(request),
      metadata: { staffUserId: existing.userId, changes: data },
    });

    return NextResponse.json({ staff: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
