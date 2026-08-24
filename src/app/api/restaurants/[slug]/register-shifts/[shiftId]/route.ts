import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { registerShifts, registerCashMovements, registerShiftCorrections } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { computeExpectedCashInPaisa } from "@/lib/cash-register";

/** Detail view: the shift itself plus its full cash-movement and correction history. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; shiftId: string }> },
) {
  try {
    const { slug, shiftId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_CASH_REGISTER,
    );

    const [shift] = await db
      .select()
      .from(registerShifts)
      .where(and(eq(registerShifts.id, shiftId), eq(registerShifts.restaurantId, restaurantId)))
      .limit(1);

    if (!shift) {
      return NextResponse.json({ error: "Register shift not found." }, { status: 404 });
    }

    await requireBranchAccess(session.user.id, restaurantId, shift.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const [movements, corrections] = await Promise.all([
      db
        .select()
        .from(registerCashMovements)
        .where(eq(registerCashMovements.shiftId, shiftId))
        .orderBy(asc(registerCashMovements.createdAt)),
      db
        .select()
        .from(registerShiftCorrections)
        .where(eq(registerShiftCorrections.shiftId, shiftId))
        .orderBy(asc(registerShiftCorrections.createdAt)),
    ]);

    let liveExpectedCashInPaisa: number | null = null;
    if (shift.status === "open") {
      liveExpectedCashInPaisa = await db.transaction((tx) =>
        computeExpectedCashInPaisa(tx, {
          shiftId: shift.id,
          branchId: shift.branchId,
          openingCashInPaisa: shift.openingCashInPaisa,
          openedAt: shift.openedAt,
          asOf: new Date(),
        }),
      );
    }

    return NextResponse.json({ shift, movements, corrections, liveExpectedCashInPaisa });
  } catch (err) {
    return toErrorResponse(err);
  }
}
