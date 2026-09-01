import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { branches, orders } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";

const RECENT_ORDERS_LIMIT = 25;

/**
 * Gap-audit P1 fix (Finding 2) — the restaurant detail page's "recent
 * orders" panel. Deliberately returns only amount/status/branch/time —
 * NOT customerName/customerPhone (guest PII the owner's own dashboard
 * shows, but a platform admin console screen reached by anyone holding
 * VIEW_TENANTS shouldn't casually surface) — same restraint the
 * restaurant list route already applies to the owner's own contact info,
 * just narrower here since there's no operational reason a platform admin
 * needs a guest's name/phone to see "this restaurant is/isn't taking
 * orders."
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.VIEW_TENANTS);
    const { restaurantId } = await ctx.params;

    const rows = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        source: orders.source,
        totalInPaisa: orders.totalInPaisa,
        branchName: branches.name,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(branches, eq(branches.id, orders.branchId))
      .where(eq(orders.restaurantId, restaurantId))
      .orderBy(desc(orders.createdAt))
      .limit(RECENT_ORDERS_LIMIT);

    return NextResponse.json({ orders: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
