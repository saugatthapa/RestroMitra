import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { registerShifts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { correctRegisterShiftSchema } from "@/lib/validation/cash-register";
import { correctRegisterShift } from "@/lib/cash-register";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Manager/owner/accountant-only: corrects a CLOSED shift's counted cash,
 * gated by CORRECT_CASH_REGISTER — a strictly higher trust tier than
 * MANAGE_CASH_REGISTER (open/close/record movements), matching the spec's
 * "manager corrections must be explicitly authorized, audited, and
 * preserve the original transaction rather than silently rewriting
 * history" (register_shift_corrections is the append-only history; see
 * correctRegisterShift's own doc comment).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; shiftId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, shiftId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.CORRECT_CASH_REGISTER,
    );

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

    const parsed = await parseJsonBody(request, correctRegisterShiftSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const { shift, correction } = await db.transaction((tx) =>
      correctRegisterShift(tx, {
        shiftId,
        newActualCashInPaisa: data.newActualCashInPaisa,
        reason: data.reason,
        correctedByUserId: session.user.id,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "register.adjusted",
      resourceType: "register_shift",
      resourceId: shift.id,
      ipAddress: getClientIp(request),
      metadata: {
        previousActualCashInPaisa: correction.previousActualCashInPaisa,
        newActualCashInPaisa: correction.newActualCashInPaisa,
        previousVarianceInPaisa: correction.previousVarianceInPaisa,
        newVarianceInPaisa: correction.newVarianceInPaisa,
        reason: correction.reason,
      },
    });

    return NextResponse.json({ shift, correction });
  } catch (err) {
    return toErrorResponse(err);
  }
}
