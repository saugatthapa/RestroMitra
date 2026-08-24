import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { dailyCloses } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";

/** Full frozen snapshot for one closed day. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; dailyCloseId: string }> },
) {
  try {
    const { slug, dailyCloseId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_DAILY_CLOSING,
    );

    const [row] = await db
      .select()
      .from(dailyCloses)
      .where(and(eq(dailyCloses.id, dailyCloseId), eq(dailyCloses.restaurantId, restaurantId)))
      .limit(1);
    if (!row) {
      return NextResponse.json({ error: "Daily close not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, row.branchId, {
      role,
      branchId: grantedBranchId,
    });

    return NextResponse.json({ dailyClose: row });
  } catch (err) {
    return toErrorResponse(err);
  }
}
