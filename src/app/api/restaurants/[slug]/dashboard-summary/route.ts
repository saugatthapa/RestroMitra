import { NextResponse } from "next/server";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, restaurantTables, inventoryItems } from "@/db/schema";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";
import { getReportSummary } from "@/lib/reports";
import { isLowStock } from "@/lib/inventory";
import { restaurantDate, restaurantStartOfDay } from "@/lib/restaurant-date";

/**
 * Powers the Dashboard home page's stat tiles and "This month's
 * performance" block (src/app/dashboard/page.tsx, rendered from
 * DashboardStats.tsx). Split out into its own client-fetched endpoint
 * (rather than the page's original server-component queries) specifically
 * so it can react to the header's branch switcher — see BranchProvider's
 * comment for why that selection is a client-side/localStorage preference
 * a server component can never see on its own; this mirrors the exact
 * pattern the Reports page already uses for the same reason
 * (src/app/api/restaurants/[slug]/reports/summary/route.ts).
 *
 * `?branchId=` scopes orders/tables/monthly figures to one branch, with
 * the same two-layer enforcement as the reports endpoint: a branch-locked
 * caller's own grant always wins over the query param, and an unrestricted
 * caller's requested branch is verified via requireBranchAccess before use.
 * `lowStockCount` is never branch-scoped — inventoryItems has no branchId
 * column (inventory is restaurant-wide by design), so it's the same number
 * regardless of the selected branch.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
    } = await resolveRestaurantContext(slug);

    const url = new URL(request.url);
    const branchIdParam = url.searchParams.get("branchId");

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, {
        role,
        branchId: grantedBranchId,
      });
      effectiveBranchId = branchIdParam;
    }

    const canViewSales = roleHasPermission(role, PERMISSIONS.VIEW_SALES);
    const canViewReports = roleHasPermission(role, PERMISSIONS.VIEW_REPORTS);

    const todayStart = restaurantStartOfDay(timezone);

    const orderScope = effectiveBranchId
      ? and(eq(orders.restaurantId, restaurantId), eq(orders.branchId, effectiveBranchId))
      : eq(orders.restaurantId, restaurantId);
    const tableScope = effectiveBranchId
      ? and(eq(restaurantTables.restaurantId, restaurantId), eq(restaurantTables.branchId, effectiveBranchId))
      : eq(restaurantTables.restaurantId, restaurantId);

    const [salesRow, ordersRow, tablesRow, activeInventoryItems] = await Promise.all([
      canViewSales
        ? db
            .select({ totalInPaisa: sql<string>`coalesce(sum(${orders.totalInPaisa}), 0)` })
            .from(orders)
            .where(and(orderScope, eq(orders.status, "completed"), gte(orders.placedAt, todayStart)))
            .then((rows) => rows[0])
        : Promise.resolve(undefined),
      db
        .select({ count: sql<string>`count(*)` })
        .from(orders)
        .where(and(orderScope, ne(orders.status, "cancelled"), gte(orders.placedAt, todayStart)))
        .then((rows) => rows[0]),
      db
        .select({ count: sql<string>`count(*)` })
        .from(restaurantTables)
        .where(and(tableScope, eq(restaurantTables.isActive, true)))
        .then((rows) => rows[0]),
      db
        .select({
          currentStockMilliunits: inventoryItems.currentStockMilliunits,
          reorderLevelMilliunits: inventoryItems.reorderLevelMilliunits,
        })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.restaurantId, restaurantId), eq(inventoryItems.isActive, true))),
    ]);
    const lowStockCount = activeInventoryItems.filter(isLowStock).length;

    const todayLocal = restaurantDate(timezone);
    const monthToDateRange = {
      from: `${todayLocal.slice(0, 7)}-01`,
      to: todayLocal,
    };
    const monthly = canViewReports
      ? await getReportSummary(restaurantId, monthToDateRange, timezone, effectiveBranchId)
      : null;

    return NextResponse.json({
      canViewSales,
      canViewReports,
      todaySalesInPaisa: canViewSales ? Number(salesRow?.totalInPaisa ?? 0) : null,
      ordersToday: Number(ordersRow?.count ?? 0),
      activeTables: Number(tablesRow?.count ?? 0),
      lowStockCount,
      monthly,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
