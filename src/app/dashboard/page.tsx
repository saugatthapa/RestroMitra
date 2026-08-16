import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { db } from "@/db";
import { orders, restaurantTables, inventoryItems } from "@/db/schema";
import { formatNPR } from "@/lib/money";
import { isLowStock } from "@/lib/inventory";
import { IconStatTile, StatIcon } from "@/components/StatTile";
import { getReportSummary } from "@/lib/reports";
import { RevenueTrendChart } from "@/app/dashboard/reports/RevenueTrendChart";
import { PERMISSIONS, roleHasPermission } from "@/lib/rbac/permissions";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard");

  const restaurants = await getUserRestaurants(session.user.id);
  if (restaurants.length === 0) redirect("/onboarding");

  const active =
    restaurants.find((r) => r.id === session.activeRestaurantId) ?? restaurants[0];

  // This landing page used to show today's revenue and the whole monthly
  // performance block (revenue, net profit, the trend chart) to *every*
  // role — a waiter or kitchen_staff account, with neither VIEW_SALES nor
  // VIEW_REPORTS, could see the restaurant's money figures just by logging
  // in, even though the dedicated Reports page (and its sidebar link)
  // already correctly hide behind those same permissions. Gating those two
  // blocks here too, and skipping the underlying queries entirely rather
  // than fetching money data that never renders.
  const canViewSales = roleHasPermission(active.role, PERMISSIONS.VIEW_SALES);
  const canViewReports = roleHasPermission(active.role, PERMISSIONS.VIEW_REPORTS);

  // "Today" here is a UTC calendar day, not the restaurant's own timezone
  // (restaurants.timezone exists but isn't threaded through yet) — same
  // simplification used throughout reports.ts (see dayBounds() there).
  // Fine for a live dashboard glance in the meantime.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const salesRow = canViewSales
    ? (
        await db
          .select({ totalInPaisa: sql<string>`coalesce(sum(${orders.totalInPaisa}), 0)` })
          .from(orders)
          .where(
            and(
              eq(orders.restaurantId, active.id),
              eq(orders.status, "completed"),
              gte(orders.placedAt, todayStart),
            ),
          )
      )[0]
    : undefined;

  const [ordersRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, active.id),
        ne(orders.status, "cancelled"),
        gte(orders.placedAt, todayStart),
      ),
    );

  const [tablesRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(restaurantTables)
    .where(and(eq(restaurantTables.restaurantId, active.id), eq(restaurantTables.isActive, true)));

  // Low-stock count reuses isLowStock() — the same pure function the
  // inventory API route uses — rather than re-deriving the "low" condition
  // here, so this tile and the inventory page can never disagree on what
  // "low" means.
  const activeInventoryItems = await db
    .select({
      currentStockMilliunits: inventoryItems.currentStockMilliunits,
      reorderLevelMilliunits: inventoryItems.reorderLevelMilliunits,
    })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.restaurantId, active.id), eq(inventoryItems.isActive, true)));
  const lowStockCount = activeInventoryItems.filter(isLowStock).length;

  // Month-to-date snapshot — same UTC-calendar-day convention as the rest
  // of this page and of reports.ts. Reuses the exact getReportSummary()
  // that powers the Reports page, so the numbers here and there can never
  // drift apart. Skipped entirely for a role without VIEW_REPORTS — same
  // reasoning as salesRow above.
  const monthToDateRange = {
    from: `${todayStart.getUTCFullYear()}-${String(todayStart.getUTCMonth() + 1).padStart(2, "0")}-01`,
    to: todayStart.toISOString().slice(0, 10),
  };
  const monthly = canViewReports ? await getReportSummary(active.id, monthToDateRange) : null;

  const statCards = [
    ...(canViewSales
      ? [
          {
            label: "Today's sales",
            value: formatNPR(Number(salesRow?.totalInPaisa ?? 0)),
            note: "Completed orders today",
            icon: <StatIcon.Rupee />,
            color: "blue" as const,
          },
        ]
      : []),
    {
      label: "Orders today",
      value: String(ordersRow?.count ?? 0),
      note: "Excludes cancelled orders",
      icon: <StatIcon.Receipt />,
      color: "orange" as const,
    },
    {
      label: "Active tables",
      value: String(tablesRow?.count ?? 0),
      note: "Manage tables and print QR codes",
      icon: <StatIcon.Table />,
      color: "teal" as const,
    },
    {
      label: "Low-stock items",
      value: String(lowStockCount),
      note: lowStockCount > 0 ? "At or below reorder level" : "Everything is stocked",
      icon: <StatIcon.AlertTriangle />,
      color: lowStockCount > 0 ? ("red" as const) : ("green" as const),
      tone: lowStockCount > 0 ? ("negative" as const) : ("neutral" as const),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-neutral-900">
          Welcome back, {session.user.fullName.split(" ")[0]}
        </h1>
        <p className="text-sm text-neutral-500">
          Orders placed by customers show up on the{" "}
          <span className="font-medium text-neutral-700">Orders</span> board in real time
          (polling every few seconds) — move them through confirmed → preparing → ready →
          served → completed from there.
          {canViewReports && (
            <>
              {" "}
              Head to <span className="font-medium text-neutral-700">Reports</span> for revenue
              trends, top items, and peak-hour analytics.
            </>
          )}
        </p>
      </div>

      <div
        className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
          statCards.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"
        }`}
      >
        {statCards.map((card) => (
          <IconStatTile
            key={card.label}
            label={card.label}
            value={card.value}
            note={card.note}
            icon={card.icon}
            color={card.color}
            tone={card.tone}
          />
        ))}
      </div>

      {/* Money figures (revenue, profit, the trend chart) are Reports-tier
          data — only rendered, and only queried above, for a role with
          VIEW_REPORTS. Everyone else's dashboard ends at the operational
          stat tiles above. */}
      {canViewReports && monthly && (
        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-neutral-900">This month&apos;s performance</h2>
            <Link href="/dashboard/reports" className="text-xs font-medium text-orange-700 hover:underline">
              Full reports →
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <IconStatTile
              label="Revenue"
              value={formatNPR(monthly.sales.revenueInPaisa)}
              icon={<StatIcon.Rupee />}
              color="blue"
              delta={{ percent: monthly.comparison.revenueChangePercent }}
            />
            <IconStatTile
              label="Net profit"
              value={formatNPR(monthly.netProfitInPaisa)}
              icon={<StatIcon.TrendUp />}
              color={monthly.netProfitInPaisa < 0 ? "red" : "green"}
              tone={monthly.netProfitInPaisa < 0 ? "negative" : "neutral"}
              delta={{ percent: monthly.comparison.netProfitChangePercent }}
            />
            <IconStatTile
              label="Peak hour"
              value={
                monthly.peakHour.peakOrdersHour === null
                  ? "—"
                  : formatHour(monthly.peakHour.peakOrdersHour)
              }
              note={
                monthly.peakHour.peakOrdersHour === null
                  ? "No completed orders yet"
                  : `${monthly.peakHour.peakOrdersCount} orders`
              }
              icon={<StatIcon.Clock />}
              color="amber"
            />
            <IconStatTile
              label="Completion rate"
              value={`${monthly.completion.completionRatePercent}%`}
              note="Paid, non-cancelled orders"
              icon={<StatIcon.CheckCircle />}
              color={monthly.completion.completionRatePercent >= 90 ? "green" : "amber"}
            />
          </div>

          <div className="mt-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
            <RevenueTrendChart series={monthly.dailySeries} />
          </div>
        </div>
      )}
    </div>
  );
}

// UTC hour-of-day -> a readable 12-hour label. Matches the same UTC
// simplification documented in reports.ts's dayBounds() comment, and the
// identical helper on the Reports page.
function formatHour(hour: number) {
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour} ${period}`;
}
