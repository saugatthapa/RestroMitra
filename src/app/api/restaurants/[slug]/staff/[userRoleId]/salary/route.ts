import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, staffSalaryConfigs } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateStaffSalarySchema } from "@/lib/validation/staff-salary";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedGrant(restaurantId: string, userRoleId: string) {
  const rows = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.id, userRoleId), eq(userRoles.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Fetch one staff member's standing salary config — null if never set. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; userRoleId: string }> },
) {
  try {
    const { slug, userRoleId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.VIEW_PAYROLL);

    const existing = await getOwnedGrant(restaurantId, userRoleId);
    if (!existing) {
      return NextResponse.json({ error: "Staff member not found." }, { status: 404 });
    }

    const config = await db.query.staffSalaryConfigs.findFirst({
      where: eq(staffSalaryConfigs.userRoleId, userRoleId),
    });

    return NextResponse.json({ salary: config ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Create or update this staff member's standing salary config (upsert). */
export async function PUT(
  request: Request,
  ctx: { params: Promise<{ slug: string; userRoleId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, userRoleId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_PAYROLL,
    );

    const existing = await getOwnedGrant(restaurantId, userRoleId);
    if (!existing) {
      return NextResponse.json({ error: "Staff member not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateStaffSalarySchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const values = {
      salaryType: data.salaryType,
      amountInPaisa: data.amount,
      paymentMethod: data.paymentMethod ?? null,
      bankName: data.bankName || null,
      bankAccountNumber: data.bankAccountNumber || null,
      bankAccountHolder: data.bankAccountHolder || null,
      note: data.note || null,
      updatedAt: new Date(),
    };

    const [config] = await db
      .insert(staffSalaryConfigs)
      .values({ userRoleId, restaurantId, ...values })
      .onConflictDoUpdate({
        target: staffSalaryConfigs.userRoleId,
        set: values,
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "staff.salary_updated",
      resourceType: "staff_salary_config",
      resourceId: config.id,
      ipAddress: getClientIp(request),
      metadata: { staffUserId: existing.userId, salaryType: data.salaryType, amountInPaisa: data.amount },
    });

    return NextResponse.json({ salary: config });
  } catch (err) {
    return toErrorResponse(err);
  }
}
