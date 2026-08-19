"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, ApiError } from "@/lib/api-client";
import { formatNPR } from "@/lib/money";
import { IconStatTile, StatIcon } from "@/components/StatTile";
import { RevenueTrendChart } from "@/app/dashboard/reports/RevenueTrendChart";
import { useActiveBranch } from "@/lib/branch-context";
import type { DailySeriesPoint } from "@/lib/reports-helpers";

type DashboardSummary = {
  canViewSales: boolean;
  canViewReports: boolean;
  todaySalesInPaisa: number | null;
  ordersToday: number;
  activeTables: number;
  lowStockCount: number;
  monthly: {
    sales: { revenueInPaisa: number };
    netProfitInPaisa: number;
    comparison: { revenueChangePercent: number | null; netProfitChangePercent: number | null };
    peakHour: { peakOrdersHour: number | null; peakOrdersCount: number };
    completion: { completionRatePercent: number };
    dailySeries: DailySeriesPoint[];
  } | null;
};

// UTC hour-of-day -> a readable 12-hour label. Matches the identical
// helper on the Reports page and reports.ts's dayBounds() UTC convention.
function formatHour(hour: number) {
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour} ${period}`;
}

/**
 * The Dashboard home page's stat tiles + "This month's performance" block.
 * Split out from page.tsx (a server component) into a client component
 * specifically so it can react to the header's branch switcher — a server
 * component has no way to see that selection at all, since it's a
 * client-side/localStorage preference (see BranchProvider's doc comment),
 * which is exactly why picking a branch there previously had no visible
 * effect on this page. Mirrors the identical pattern ReportsBoard.tsx
 * already uses for the same reason.
 */
export function DashboardStats({ slug }: { slug: string }) {
  const { activeBranchId } = useActiveBranch();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const params = new URLSearchParams();
        if (activeBranchId) params.set("branchId", activeBranchId);
        const query = params.toString();
        const res = await apiGet<DashboardSummary>(
          `/api/restaurants/${slug}/dashboard-summary${query ? `?${query}` : ""}`,
        );
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load dashboard data.");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [slug, activeBranchId]);

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (!data) {
    // Skeleton-free, deliberately minimal loading state — this section
    // refreshes on every branch switch too, and a flash of layout-shifting
    // skeleton tiles on every switch would be more distracting than useful
    // for what's typically a sub-second fetch.
    return <p className="text-sm text-neutral-400">Loading…</p>;
  }

  const { canViewSales, canViewReports, monthly } = data;

  const statCards = [
    ...(canViewSales
      ? [
          {
            label: "Today's sales",
            value: formatNPR(data.todaySalesInPaisa ?? 0),
            note: "Completed orders today",
            icon: <StatIcon.Rupee />,
            color: "blue" as const,
          },
        ]
      : []),
    {
      label: "Orders today",
      value: String(data.ordersToday),
      note: "Excludes cancelled orders",
      icon: <StatIcon.Receipt />,
      color: "orange" as const,
    },
    {
      label: "Active tables",
      value: String(data.activeTables),
      note: "Manage tables and print QR codes",
      icon: <StatIcon.Table />,
      color: "teal" as const,
    },
    {
      label: "Low-stock items",
      value: String(data.lowStockCount),
      note: data.lowStockCount > 0 ? "At or below reorder level" : "Everything is stocked",
      icon: <StatIcon.AlertTriangle />,
      color: data.lowStockCount > 0 ? ("red" as const) : ("green" as const),
      tone: data.lowStockCount > 0 ? ("negative" as const) : ("neutral" as const),
    },
  ];

  return (
    <>
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
    </>
  );
}
