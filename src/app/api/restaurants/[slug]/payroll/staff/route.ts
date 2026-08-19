import { NextResponse } from "next/server";
import { and, eq, max } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, users, staffSalaryConfigs, payrollPayments } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";

/**
 * The Payroll tab's roster: every active staff member (owner included, so
 * an owner who also draws a salary can be paid through the same flow),
 * their standing salary config if one's been set, and when they were last
 * paid — enough for the UI to show a "Pay" button pre-filled with sane
 * defaults without a second round trip per row.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.VIEW_PAYROLL);

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
      .where(and(eq(userRoles.restaurantId, restaurantId), eq(userRoles.isActive, true)));

    const lastPaidRows = await db
      .select({
        userRoleId: payrollPayments.userRoleId,
        lastPaidAt: max(payrollPayments.paidAt),
      })
      .from(payrollPayments)
      .where(and(eq(payrollPayments.restaurantId, restaurantId), eq(payrollPayments.isVoided, false)))
      .groupBy(payrollPayments.userRoleId);
    const lastPaidByUserRoleId = new Map(lastPaidRows.map((r) => [r.userRoleId, r.lastPaidAt]));

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
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
