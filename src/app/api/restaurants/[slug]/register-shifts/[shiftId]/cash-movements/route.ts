import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { registerShifts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { recordCashMovementSchema } from "@/lib/validation/cash-register";
import { recordCashMovement } from "@/lib/cash-register";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const AUDIT_ACTION_BY_TYPE: Record<string, string> = {
  addition: "cash.added",
  drop: "cash.dropped",
  payout: "cash.payout",
};

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
      PERMISSIONS.MANAGE_CASH_REGISTER,
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

    const parsed = await parseJsonBody(request, recordCashMovementSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const movement = await db.transaction((tx) =>
      recordCashMovement(tx, {
        shiftId,
        type: data.type,
        amountInPaisa: data.amountInPaisa,
        reason: data.reason ?? null,
        recordedByUserId: session.user.id,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: AUDIT_ACTION_BY_TYPE[data.type] ?? "cash.movement",
      resourceType: "register_cash_movement",
      resourceId: movement.id,
      ipAddress: getClientIp(request),
      metadata: { shiftId, type: data.type, amountInPaisa: data.amountInPaisa, reason: data.reason },
    });

    return NextResponse.json({ movement }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
