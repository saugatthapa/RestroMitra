import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { payrollPayments, restaurants, userRoles, users } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { computePayslipTotals } from "@/lib/payslip";
import { STAFF_ROLE_LABELS, type AssignableStaffRole } from "@/lib/staff-roles";

/**
 * Commercial completion pass — payslip generation (the one gap the
 * previous hardening report honestly flagged as missing: payroll
 * computation and payment/void tracking existed, but no document a staff
 * member could be handed did). Read-only, VIEW_PAYROLL-gated (same as the
 * payment list) — no new write surface, this just assembles what's
 * already recorded on the payrollPayments row into a receipt shape the
 * print view renders.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; paymentId: string }> },
) {
  try {
    const { slug, paymentId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.VIEW_PAYROLL,
    );

    const rows = await db
      .select({
        payment: payrollPayments,
        staffBranchId: userRoles.branchId,
        staffRole: userRoles.role,
        staffEmail: users.email,
      })
      .from(payrollPayments)
      .innerJoin(userRoles, eq(payrollPayments.userRoleId, userRoles.id))
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(and(eq(payrollPayments.id, paymentId), eq(payrollPayments.restaurantId, restaurantId)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return NextResponse.json({ error: "Payroll payment not found." }, { status: 404 });
    }

    // Same branch-isolation rule as the list route — a branch-scoped
    // viewer must not be able to pull a payslip for a different branch's
    // staff member by guessing/enumerating payment IDs.
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, row.staffBranchId, {
      role,
      branchId: grantedBranchId,
    });

    const [restaurant] = await db
      .select({
        name: restaurants.name,
        address: restaurants.address,
        city: restaurants.city,
        district: restaurants.district,
        panVat: restaurants.panVat,
        phone: restaurants.phone,
        logoUrl: restaurants.logoUrl,
      })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    const totals = computePayslipTotals(row.payment.amountInPaisa, row.payment.deductionsJson);
    const roleLabel =
      STAFF_ROLE_LABELS[row.staffRole as AssignableStaffRole] ??
      row.staffRole.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    return NextResponse.json({
      restaurant,
      staff: {
        name: row.payment.staffNameSnapshot,
        role: roleLabel,
        email: row.staffEmail,
      },
      payment: {
        id: row.payment.id,
        payPeriodLabel: row.payment.payPeriodLabel,
        periodStart: row.payment.periodStart,
        periodEnd: row.payment.periodEnd,
        paymentMethod: row.payment.paymentMethod,
        note: row.payment.note,
        paidAt: row.payment.paidAt,
        isVoided: row.payment.isVoided,
        attendanceMinutesSnapshot: row.payment.attendanceMinutesSnapshot,
        attendanceDaysSnapshot: row.payment.attendanceDaysSnapshot,
      },
      totals,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
