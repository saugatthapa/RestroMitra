"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, ApiError } from "@/lib/api-client";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/payments";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/lib/expense-categories";
import type { DailySeriesPoint } from "@/lib/reports-helpers";
import { RevenueTrendChart } from "./RevenueTrendChart";
import { HourlyHeatmap, type HourlyHeatmapCell } from "./HourlyHeatmap";
import { IconStatTile, StatIcon } from "@/components/StatTile";

// Chart chrome tokens, matching RevenueTrendChart's validated palette
// (dataviz skill, palette.md) — used here for the small inline breakdown
// bars so the whole page reads as one consistent system.
const REVENUE_COLOR = "#2a78d6";
const EXPENSES_COLOR = "#eb6834";
const SECONDARY_TEXT_COLOR = "#52514e";

type ReportSummary = {
  range: { from: string; to: string };
  sales: {
    revenueInPaisa: number;
    orderCount: number;
    averageOrderValueInPaisa: number;
    cancelledCount: number;
    discountInPaisa: number;
    serviceChargeInPaisa: number;
  };
  totalExpensesInPaisa: number;
  netProfitInPaisa: number;
  dailySeries: DailySeriesPoint[];
  topItems: { name: string; quantitySold: number; revenueInPaisa: number }[];
  paymentBreakdown: { method: PaymentMethod; totalInPaisa: number }[];
  expenseBreakdown: { category: ExpenseCategory; totalInPaisa: number }[];
  totalTipsInPaisa: number;
  peakHour: {
    peakOrdersHour: number | null;
    peakOrdersCount: number;
    peakSalesHour: number | null;
    peakSalesInPaisa: number;
  };
  completion: {
    completionRatePercent: number;
    avgCompletionMinutes: number | null;
  };
  comparison: {
    previousRange: { from: string; to: string };
    revenueChangePercent: number | null;
    ordersChangePercent: number | null;
    avgOrderValueChangePercent: number | null;
    netProfitChangePercent: number | null;
  };
  hourlyHeatmap: HourlyHeatmapCell[];
  branchComparison: {
    branchId: string;
    branchName: string;
    isMain: boolean;
    revenueInPaisa: number;
    orderCount: number;
    averageOrderValueInPaisa: number;
  }[];
};

// UTC hour-of-day -> a readable 12-hour label. Matches the same UTC
// simplification documented in reports.ts's dayBounds() comment.
function formatHour(hour: number | null) {
  if (hour === null) return "—";
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour} ${period}`;
}

function formatShortDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatMinutes(minutes: number | null) {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function formatRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function firstOfMonthIso() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// Presets before a custom range — dataviz skill's "date range first, presets
// before custom range" rule.
const PRESETS = [
  { label: "Today", from: () => todayIso(), to: () => todayIso() },
  { label: "Last 7 days", from: () => daysAgoIso(6), to: () => todayIso() },
  { label: "Last 30 days", from: () => daysAgoIso(29), to: () => todayIso() },
  { label: "This month", from: () => firstOfMonthIso(), to: () => todayIso() },
] as const;

export function ReportsBoard({ slug }: { slug: string }) {
  const [from, setFrom] = useState(daysAgoIso(29));
  const [to, setTo] = useState(todayIso());
  const [activePreset, setActivePreset] = useState<string | null>("Last 30 days");
  const [data, setData] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ from, to });
        const res = await apiGet<ReportSummary>(`${base(slug)}/reports/summary?${params}`);
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load reports.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [slug, from, to]);

  function applyPreset(preset: (typeof PRESETS)[number]) {
    setFrom(preset.from());
    setTo(preset.to());
    setActivePreset(preset.label);
  }

  const maxPaymentTotal = useMemo(
    () => Math.max(1, ...(data?.paymentBreakdown.map((r) => r.totalInPaisa) ?? [1])),
    [data],
  );
  const maxExpenseTotal = useMemo(
    () => Math.max(1, ...(data?.expenseBreakdown.map((r) => r.totalInPaisa) ?? [1])),
    [data],
  );
  const maxBranchRevenue = useMemo(
    () => Math.max(1, ...(data?.branchComparison.map((r) => r.revenueInPaisa) ?? [1])),
    [data],
  );

  return (
    <div>
      {/* Filter row — sits above every section it scopes, per the dataviz
          skill's "one row, above the charts" / "filters scope everything
          below them" rules. */}
      <div className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => applyPreset(preset)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                activePreset === preset.label
                  ? "bg-orange-600 text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <label className="flex items-center gap-1.5 text-neutral-600">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => {
                setFrom(e.target.value);
                setActivePreset(null);
              }}
              className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-1.5 text-neutral-600">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={todayIso()}
              onChange={(e) => {
                setTo(e.target.value);
                setActivePreset(null);
              }}
              className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Refetch keeps the frame — hold the previous render at reduced
          opacity instead of flashing a skeleton, per the dataviz skill. */}
      <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {data && (
          <>
            <p className="mb-3 text-xs text-neutral-400">
              Revenue, orders, avg. order value, and net profit are compared against the
              previous {formatShortDate(data.comparison.previousRange.from)} –{" "}
              {formatShortDate(data.comparison.previousRange.to)} (same length as the selected
              range).
            </p>
            {/* KPI stat tiles */}
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <IconStatTile
                label="Revenue"
                value={formatRupees(data.sales.revenueInPaisa)}
                icon={<StatIcon.Rupee />}
                color="blue"
                delta={{ percent: data.comparison.revenueChangePercent }}
              />
              <IconStatTile
                label="Orders"
                value={data.sales.orderCount.toLocaleString("en-IN")}
                icon={<StatIcon.Receipt />}
                color="orange"
                delta={{ percent: data.comparison.ordersChangePercent }}
              />
              <IconStatTile
                label="Avg. order value"
                value={formatRupees(data.sales.averageOrderValueInPaisa)}
                icon={<StatIcon.Calculator />}
                color="teal"
                delta={{ percent: data.comparison.avgOrderValueChangePercent }}
              />
              <IconStatTile
                label="Total expenses"
                value={formatRupees(data.totalExpensesInPaisa)}
                icon={<StatIcon.TrendDown />}
                color="amber"
              />
              <IconStatTile
                label="Net profit"
                value={formatRupees(data.netProfitInPaisa)}
                icon={<StatIcon.TrendUp />}
                color={data.netProfitInPaisa < 0 ? "red" : "green"}
                tone={data.netProfitInPaisa < 0 ? "negative" : "neutral"}
                delta={{ percent: data.comparison.netProfitChangePercent }}
              />
              <IconStatTile
                label="Discounts given"
                value={formatRupees(data.sales.discountInPaisa)}
                icon={<StatIcon.Percent />}
                color="purple"
              />
              <IconStatTile
                label="Service charge collected"
                value={formatRupees(data.sales.serviceChargeInPaisa)}
                icon={<StatIcon.Wallet />}
                color="blue"
              />
              <IconStatTile
                label="Tips collected"
                value={formatRupees(data.totalTipsInPaisa)}
                icon={<StatIcon.Gift />}
                color="purple"
              />
            </div>

            {/* Peak-hour + completion tiles — the reference dashboard shows
                these as a dual-axis revenue/orders chart; a single dual-axis
                line chart mixing two different scales is the #1 anti-pattern
                (dataviz skill), so instead these are surfaced as plain,
                unambiguous numbers: which hour tends to be busiest (by
                order count and, separately, by revenue — they don't have to
                agree), plus how reliably orders get paid off and how long
                that tends to take. */}
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <IconStatTile
                label="Peak hour (orders)"
                value={formatHour(data.peakHour.peakOrdersHour)}
                note={
                  data.peakHour.peakOrdersHour !== null
                    ? `${data.peakHour.peakOrdersCount} orders`
                    : "No completed orders yet"
                }
                icon={<StatIcon.Clock />}
                color="amber"
              />
              <IconStatTile
                label="Peak hour (sales)"
                value={formatHour(data.peakHour.peakSalesHour)}
                note={
                  data.peakHour.peakSalesHour !== null
                    ? formatRupees(data.peakHour.peakSalesInPaisa)
                    : "No completed orders yet"
                }
                icon={<StatIcon.Flame />}
                color="orange"
              />
              <IconStatTile
                label="Completion rate"
                value={`${data.completion.completionRatePercent}%`}
                note="Paid, non-cancelled orders"
                icon={<StatIcon.CheckCircle />}
                color={data.completion.completionRatePercent >= 90 ? "green" : "amber"}
              />
              <IconStatTile
                label="Avg. completion time"
                value={formatMinutes(data.completion.avgCompletionMinutes)}
                note="Placed → completed (approx.)"
                icon={<StatIcon.Clock />}
                color="teal"
              />
            </div>

            {/* Revenue vs expenses trend */}
            <div className="mb-6 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                Revenue vs. expenses
              </h2>
              <RevenueTrendChart series={data.dailySeries} />
            </div>

            {/* Hour-by-day-of-week heatmap — a finer-grained view than the
                single Peak hour tiles above, e.g. spotting that Friday
                dinners specifically outpace every other evening. */}
            <div className="mb-6 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                Busiest hours by day of week
              </h2>
              <HourlyHeatmap cells={data.hourlyHeatmap} />
            </div>

            {/* Branch comparison — only meaningful once there's more than
                one branch to compare (every restaurant gets one branch at
                onboarding, so a single-branch result is the common case
                and isn't worth a whole section). Same categorical-by-
                magnitude bar treatment as the payment/expense breakdowns
                below, plus a table for the exact figures and an "All
                branches" total row so the numbers reconcile with the KPI
                tiles above. */}
            {data.branchComparison.length > 1 && (
              <div className="mb-6 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                  Branch comparison
                </h2>
                <div className="mb-4 space-y-2.5">
                  {data.branchComparison.map((b) => (
                    <BreakdownBar
                      key={b.branchId}
                      label={b.branchName}
                      valueLabel={formatRupees(b.revenueInPaisa)}
                      fraction={b.revenueInPaisa / maxBranchRevenue}
                      color={REVENUE_COLOR}
                    />
                  ))}
                </div>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
                    <tr>
                      <th className="pb-2">Branch</th>
                      <th className="pb-2 text-right">Orders</th>
                      <th className="pb-2 text-right">Avg. order value</th>
                      <th className="pb-2 text-right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.branchComparison.map((b) => (
                      <tr key={b.branchId} className="border-t border-neutral-100">
                        <td className="py-1.5 text-neutral-800">
                          {b.branchName}
                          {b.isMain && (
                            <span className="ml-1.5 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
                              Main
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 text-right text-neutral-600">{b.orderCount}</td>
                        <td className="py-1.5 text-right text-neutral-600">
                          {formatRupees(b.averageOrderValueInPaisa)}
                        </td>
                        <td className="py-1.5 text-right font-medium text-neutral-900">
                          {formatRupees(b.revenueInPaisa)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-neutral-200 bg-neutral-50/60 font-semibold text-neutral-900">
                      <td className="py-1.5">All branches</td>
                      <td className="py-1.5 text-right">{data.sales.orderCount}</td>
                      <td className="py-1.5 text-right">
                        {formatRupees(data.sales.averageOrderValueInPaisa)}
                      </td>
                      <td className="py-1.5 text-right">{formatRupees(data.sales.revenueInPaisa)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {/* Top-selling items */}
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm lg:col-span-1">
                <h2 className="mb-3 text-sm font-semibold text-neutral-900">Top-selling items</h2>
                {data.topItems.length === 0 ? (
                  <p className="text-sm text-neutral-400">No completed orders in this range.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
                      <tr>
                        <th className="pb-2">Item</th>
                        <th className="pb-2 text-right">Qty</th>
                        <th className="pb-2 text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topItems.map((item) => (
                        <tr key={item.name} className="border-t border-neutral-100">
                          <td className="py-1.5 text-neutral-800">{item.name}</td>
                          <td className="py-1.5 text-right text-neutral-600">{item.quantitySold}</td>
                          <td className="py-1.5 text-right font-medium text-neutral-900">
                            {formatRupees(item.revenueInPaisa)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Payment method breakdown */}
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm lg:col-span-1">
                <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                  Payment methods
                </h2>
                {data.paymentBreakdown.length === 0 ? (
                  <p className="text-sm text-neutral-400">No payments in this range.</p>
                ) : (
                  <div className="space-y-2.5">
                    {data.paymentBreakdown.map((row) => (
                      <BreakdownBar
                        key={row.method}
                        label={PAYMENT_METHOD_LABELS[row.method]}
                        valueLabel={formatRupees(row.totalInPaisa)}
                        fraction={row.totalInPaisa / maxPaymentTotal}
                        color={REVENUE_COLOR}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Expense category breakdown */}
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm lg:col-span-1">
                <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                  Expenses by category
                </h2>
                {data.expenseBreakdown.length === 0 ? (
                  <p className="text-sm text-neutral-400">No expenses in this range.</p>
                ) : (
                  <div className="space-y-2.5">
                    {data.expenseBreakdown.map((row) => (
                      <BreakdownBar
                        key={row.category}
                        label={EXPENSE_CATEGORY_LABELS[row.category]}
                        valueLabel={formatRupees(row.totalInPaisa)}
                        fraction={row.totalInPaisa / maxExpenseTotal}
                        color={EXPENSES_COLOR}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BreakdownBar({
  label,
  valueLabel,
  fraction,
  color,
}: {
  label: string;
  valueLabel: string;
  fraction: number;
  color: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span style={{ color: SECONDARY_TEXT_COLOR }}>{label}</span>
        <span className="font-medium text-neutral-900">{valueLabel}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(2, Math.min(100, fraction * 100))}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
