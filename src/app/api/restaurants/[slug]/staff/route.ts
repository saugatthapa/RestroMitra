import { NextResponse } from "next/server";
import { and, count, eq, isNull, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { users, userRoles, restaurants, branches, staffSalaryConfigs } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { hasPermission } from "@/lib/rbac/guard";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { addStaffSchema } from "@/lib/validation/staff";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { maxStaffForRestaurant } from "@/lib/plans-db";

/**
 * Lists everyone with an active role at this restaurant — owner included
 * (for visibility on the roster), though the owner row can't be edited or
 * deactivated through the staff PATCH route (see [userRoleId]/route.ts).
 *
 * QA hardening pass — a branch-scoped manager (grantedBranchId !== null)
 * only sees staff who are either scoped to their own branch or unrestricted
 * (branchId IS NULL — e.g. the owner, who should stay visible on every
 * branch's roster). Restaurant-wide staff at OTHER branches are excluded,
 * same invariant requireBranchAccessForNullableTarget enforces for the
 * single-staff-member routes.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
    );

    const rows = await db
      .select({
        id: userRoles.id,
        role: userRoles.role,
        isActive: userRoles.isActive,
        createdAt: userRoles.createdAt,
        userId: users.id,
        fullName: users.fullName,
        phone: users.phone,
        branchId: userRoles.branchId,
        branchName: branches.name,
      })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .leftJoin(branches, eq(userRoles.branchId, branches.id))
      .where(
        grantedBranchId === null
          ? eq(userRoles.restaurantId, restaurantId)
          : and(
              eq(userRoles.restaurantId, restaurantId),
              or(isNull(userRoles.branchId), eq(userRoles.branchId, grantedBranchId)),
            ),
      );

    return NextResponse.json({ staff: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Adds a staff member: find-or-create by phone, then grant a role at THIS
 * restaurant. A phone that already has an account elsewhere (or that
 * simply registered themselves once with no restaurant) is reused as-is —
 * `users.phone` is globally unique, one phone is one person account-wide,
 * who can hold separate role grants at separate restaurants. fullName/
 * password are required only when actually creating a brand-new account;
 * ignored otherwise (the schema can't express that conditional — see its
 * own comment).
 *
 * At most one ACTIVE role per user per restaurant is enforced here (even
 * though the DB's unique constraint technically allows multiple roles for
 * the same user+restaurant+branch) — the rest of the app (
 * requireRestaurantAccess, the dashboard's `role` display, etc.) assumes a
 * single role per person per restaurant, so allowing a second active role
 * would just create an ambiguous "which one wins" bug elsewhere.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
    );

    const parsed = await parseJsonBody(request, addStaffSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    // Phase 10 — plan-limited staff seats. Owner doesn't count against
    // their own restaurant's limit (see maxStaffForRestaurant's own
    // comment); a trial with no plan assigned yet gets the generous
    // TRIAL_MAX_STAFF default rather than blocking evaluation.
    const [restaurantRow] = await db
      .select({ planKey: restaurants.planKey })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    const maxStaff = await maxStaffForRestaurant(restaurantRow ?? { planKey: null });
    if (maxStaff !== null) {
      const [staffCountRow] = await db
        .select({ n: count() })
        .from(userRoles)
        .where(
          and(
            eq(userRoles.restaurantId, restaurantId),
            eq(userRoles.isActive, true),
            ne(userRoles.role, "owner"),
          ),
        );
      if ((staffCountRow?.n ?? 0) >= maxStaff) {
        return NextResponse.json(
          {
            error: `You've reached your plan's staff limit (${maxStaff}). Upgrade your plan from the Billing page to add more.`,
          },
          { status: 403 },
        );
      }
    }

    const existingUserRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, data.phone))
      .limit(1);
    let userId = existingUserRows[0]?.id ?? null;

    if (!userId) {
      if (!data.fullName || !data.password) {
        return NextResponse.json(
          { error: "Full name and a password are required for a new staff account." },
          { status: 400 },
        );
      }
      const passwordIssue = validatePasswordStrength(data.password);
      if (passwordIssue) {
        return NextResponse.json({ error: passwordIssue }, { status: 400 });
      }
      const passwordHash = await hashPassword(data.password);
      const [created] = await db
        .insert(users)
        .values({ fullName: data.fullName, phone: data.phone, passwordHash })
        .returning({ id: users.id });
      userId = created.id;
    } else {
      const existingGrant = await db
        .select({ id: userRoles.id })
        .from(userRoles)
        .where(
          and(
            eq(userRoles.userId, userId),
            eq(userRoles.restaurantId, restaurantId),
            eq(userRoles.isActive, true),
          ),
        )
        .limit(1);
      if (existingGrant.length > 0) {
        return NextResponse.json(
          { error: "This person is already an active staff member here. Edit their role instead." },
          { status: 409 },
        );
      }
    }

    // A client-supplied branchId is only trusted once verified to belong
    // to this restaurant — same "resolve, don't trust" pattern as every
    // other id accepted in a request body across this app.
    let branchId: string | null = null;
    if (data.branchId) {
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

    const [grant] = await db
      .insert(userRoles)
      .values({
        userId,
        restaurantId,
        branchId,
        role: data.role,
        invitedBy: session.user.id,
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "staff.added",
      resourceType: "user_role",
      resourceId: grant.id,
      ipAddress: getClientIp(request),
      metadata: { staffUserId: userId, role: data.role, branchId },
    });

    // Phase 22 — salary info is only ever persisted when the caller
    // themselves holds MANAGE_PAYROLL, regardless of what the request body
    // contains: a manager can add staff (MANAGE_STAFF) but must NOT be
    // able to set pay info through this same form, since salary stays
    // behind a stricter, separate permission wall (see permissions.ts).
    // Decoupled from the userRoles insert above (not one shared
    // transaction) — this route was already non-transactional for its
    // other side effects (audit log, staff-count check), and a failed
    // salary insert shouldn't roll back a staff account that was
    // otherwise created successfully; the owner can just fill in salary
    // again from the Payroll tab.
    let salarySaved = false;
    if (data.salary) {
      const canManagePayroll = await hasPermission(
        session.user.id,
        restaurantId,
        PERMISSIONS.MANAGE_PAYROLL,
        role,
      );
      if (canManagePayroll) {
        await db.insert(staffSalaryConfigs).values({
          userRoleId: grant.id,
          restaurantId,
          salaryType: data.salary.salaryType,
          amountInPaisa: data.salary.amount,
          paymentMethod: data.salary.paymentMethod ?? null,
          bankName: data.salary.bankName || null,
          bankAccountNumber: data.salary.bankAccountNumber || null,
          bankAccountHolder: data.salary.bankAccountHolder || null,
          note: data.salary.note || null,
        });
        salarySaved = true;
      }
    }

    const [staffUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    return NextResponse.json(
      {
        staff: {
          id: grant.id,
          role: grant.role,
          isActive: grant.isActive,
          createdAt: grant.createdAt,
          userId,
          fullName: staffUser.fullName,
          phone: staffUser.phone,
          branchId: grant.branchId,
        },
        salarySaved,
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
