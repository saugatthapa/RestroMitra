import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { registerShifts, registerCashMovements, registerShiftCorrections } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { computeCashRegisterBreakdown } from "@/lib/cash-register";

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

    // For an OPEN shift this is the live, still-moving breakdown (asOf =
    // now). For a CLOSED shift, expectedCashInPaisa/actualCashInPaisa/
    // varianceInPaisa are already frozen on the row itself (see the block
    // comment above `registerShifts` in schema.ts) — recomputing the
    // breakdown here just re-derives the LINE ITEMS behind that frozen
    // total (asOf = the shift's own closedAt), purely for display on the
    // shift-history detail view. This never overwrites the frozen columns;
    // payments/expenses in a closed window are immutable (a closed
    // business day can't take new backdated rows — see daily-closing.ts),
    // so recomputing it is safe and always reproduces the same total that
    // was frozen at close time.
    const breakdown = await db.transaction((tx) =>
      computeCashRegisterBreakdown(tx, {
        shiftId: shift.id,
        branchId: shift.branchId,
        openingCashInPaisa: shift.openingCashInPaisa,
        openedAt: shift.openedAt,
        asOf: shift.status === "open" ? new Date() : shift.closedAt!,
      }),
    );

    return NextResponse.json({ shift, movements, corrections, breakdown });
  } catch (err) {
    return toErrorResponse(err);
  }
}
