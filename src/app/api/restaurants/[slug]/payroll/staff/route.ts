import { NextResponse } from "next/server";
import { and, eq, isNull, max, or } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, users, staffSalaryConfigs, payrollPayments } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getPayrollComputation } from "@/lib/payroll";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Payroll tab's roster: every active staff member (owner included, so
 * an owner who also draws a salary can be paid through the same flow),
 * their standing salary config if one's been set, and when they were last
 * paid — enough for the UI to show a "Pay" button pre-filled with sane
 * defaults without a second round trip per row.
 *
 * Commercial Launch Phase B.2 — `?periodStart=&periodEnd=` (both required
 * together, YYYY-MM-DD) additionally computes each staff member's owed
 * amount for that period from attendance (see getPayrollComputation) —
 * the Payroll tab's period picker uses this to show "here's what everyone
 * is owed for August" before anyone clicks Pay. Omitted (or malformed)
 * params just skip the computation — `computation` stays null on every
 * row, same as before this phase.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, timezone, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.VIEW_PAYROLL,
    );

    const url = new URL(request.url);
    const periodStart = url.searchParams.get("periodStart");
    const periodEnd = url.searchParams.get("periodEnd");
    const hasValidPeriod =
      !!periodStart && !!periodEnd && ISO_DATE.test(periodStart) && ISO_DATE.test(periodEnd) && periodStart <= periodEnd;

    // QA hardening pass — a branch-scoped accountant/manager only sees the
    // payroll roster for their own branch (plus unrestricted/restaurant-wide
    // staff, same as the staff roster route), not every branch's payroll.
    const staffRows = await db
      .select({
        userRoleId: userRoles.id,
        userId: users.id,
        fullName: users.fullName,
        phone: users.phone,
        role: userRoles.role,
        isActive: userRoles.isActive,
        salary: staffSalaryConfigs,
      })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .leftJoin(staffSalaryConfigs, eq(staffSalaryConfigs.userRoleId, userRoles.id))
      .where(
        grantedBranchId === null
          ? and(eq(userRoles.restaurantId, restaurantId), eq(userRoles.isActive, true))
          : and(
              eq(userRoles.restaurantId, restaurantId),
              eq(userRoles.isActive, true),
              or(isNull(userRoles.branchId), eq(userRoles.branchId, grantedBranchId)),
            ),
      );

    const lastPaidRows = await db
      .select({
        userRoleId: payrollPayments.userRoleId,
        lastPaidAt: max(payrollPayments.paidAt),
      })
      .from(payrollPayments)
      .where(and(eq(payrollPayments.restaurantId, restaurantId), eq(payrollPayments.isVoided, false)))
      .groupBy(payrollPayments.userRoleId);
    const lastPaidByUserRoleId = new Map(lastPaidRows.map((r) => [r.userRoleId, r.lastPaidAt]));

    // Only worth computing for a row that actually HAS a salary config —
    // getPayrollComputation returns null for one that doesn't anyway, but
    // skipping the query entirely avoids N pointless round trips on a
    // roster where most staff have no salary set yet.
    const computations = hasValidPeriod
      ? new Map(
          await Promise.all(
            staffRows
              .filter((r) => r.salary !== null)
              .map(
                async (r) =>
                  [
                    r.userRoleId,
                    await getPayrollComputation(restaurantId, r.userRoleId, periodStart!, periodEnd!, timezone),
                  ] as const,
              ),
          ),
        )
      : new Map();

    return NextResponse.json({
      staff: staffRows
        .map((r) => ({
          userRoleId: r.userRoleId,
          userId: r.userId,
          fullName: r.fullName,
          phone: r.phone,
          role: r.role,
          salary: r.salary,
          lastPaidAt: lastPaidByUserRoleId.get(r.userRoleId) ?? null,
          computation: computations.get(r.userRoleId) ?? null,
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
