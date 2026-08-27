import { NextResponse } from "next/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { branches, userRoles, users } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { toCsv } from "@/lib/csv";

/**
 * Commercial completion pass — Data Export gap. Same branch-scoping rule
 * and permission (MANAGE_STAFF) as GET /staff. Deliberately roster fields
 * only — no salary/pay figures, same privacy boundary the payroll schema
 * itself documents (staffSalaryConfigs' own comment: salary information
 * must stay behind VIEW_PAYROLL/MANAGE_PAYROLL, never leak through a
 * staff-roster-scoped view).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
    );

    const rows = await db
      .select({
        role: userRoles.role,
        isActive: userRoles.isActive,
        createdAt: userRoles.createdAt,
        fullName: users.fullName,
        phone: users.phone,
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

    const csv = toCsv(rows, [
      { header: "Name", value: (r) => r.fullName },
      { header: "Phone", value: (r) => r.phone },
      { header: "Role", value: (r) => r.role },
      { header: "Branch", value: (r) => r.branchName ?? "All branches" },
      { header: "Active", value: (r) => r.isActive },
      { header: "Joined", value: (r) => r.createdAt.toISOString() },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="staff.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
