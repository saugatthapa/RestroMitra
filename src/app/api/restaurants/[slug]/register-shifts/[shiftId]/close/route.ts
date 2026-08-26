import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { registerShifts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { closeRegisterShiftSchema } from "@/lib/validation/cash-register";
import { closeRegisterShift } from "@/lib/cash-register";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; shiftId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, shiftId } = await ctx.params;
    const { session, restaurantId, role, timezone, branchId: grantedBranchId } =
      await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_CASH_REGISTER);

    const [existing] = await db
      .select({ id: registerShifts.id, branchId: registerShifts.branchId })
      .from(registerShifts)
      .where(and(eq(registerShifts.id, shiftId), eq(registerShifts.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Register shift not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const parsed = await parseJsonBody(request, closeRegisterShiftSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const shift = await db.transaction((tx) =>
      closeRegisterShift(tx, {
        shiftId,
        actualCashInPaisa: data.actualCashInPaisa,
        closingNotes: data.closingNotes ?? null,
        closedByUserId: session.user.id,
        timezone,
        role,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "register.closed",
      resourceType: "register_shift",
      resourceId: shift.id,
      ipAddress: getClientIp(request),
      metadata: {
        expectedCashInPaisa: shift.expectedCashInPaisa,
        actualCashInPaisa: shift.actualCashInPaisa,
        varianceInPaisa: shift.varianceInPaisa,
      },
    });

    return NextResponse.json({ shift });
  } catch (err) {
    return toErrorResponse(err);
  }
}
