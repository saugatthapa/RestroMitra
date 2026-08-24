import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { registerShifts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { computeExpectedCashInPaisa } from "@/lib/cash-register";

/**
 * Returns the CALLING USER's own open shift, if any — what a POS/cashier
 * screen checks on load to decide "show me the till" vs. "prompt to open
 * a shift." Deliberately scoped to the caller (openedByUserId), not the
 * branch, since register_shifts_one_open_per_cashier is per-user: two
 * cashiers on the same branch could each have their own open shift on
 * different registers.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_CASH_REGISTER,
    );

    const [shift] = await db
      .select()
      .from(registerShifts)
      .where(
        and(
          eq(registerShifts.restaurantId, restaurantId),
          eq(registerShifts.openedByUserId, session.user.id),
          eq(registerShifts.status, "open"),
        ),
      )
      .limit(1);

    if (!shift) {
      return NextResponse.json({ shift: null });
    }

    const liveExpectedCashInPaisa = await db.transaction((tx) =>
      computeExpectedCashInPaisa(tx, {
        shiftId: shift.id,
        branchId: shift.branchId,
        openingCashInPaisa: shift.openingCashInPaisa,
        openedAt: shift.openedAt,
        asOf: new Date(),
      }),
    );

    return NextResponse.json({ shift, liveExpectedCashInPaisa });
  } catch (err) {
    return toErrorResponse(err);
  }
}
