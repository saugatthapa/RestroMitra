"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, ApiError } from "@/lib/api-client";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/payments";
import type { DailySeriesPoint } from "@/lib/reports-helpers";
import { RevenueTrendChart } from "./RevenueTrendChart";
import { HourlyHeatmap, type HourlyHeatmapCell } from "./HourlyHeatmap";
import { IconStatTile, StatIcon } from "@/components/StatTile";
import { useDateSystem, type DateSystem } from "@/lib/date-system";
import { useActiveBranch } from "@/lib/branch-context";
import { formatDate, formatBsHint } from "@/lib/nepali-date";
import { localDateIso } from "@/lib/local-date";
import { WASTE_REASON_LABELS, type WasteReasonValue } from "@/lib/waste-reasons";
import { ORDER_STATUS_LABELS, type OrderStatus } from "@/lib/order-status";

// Chart chrome tokens, matching RevenueTrendChart's validated palette
// (dataviz skill, palette.md) — used here for the small inline breakdown
// bars so the whole page reads as one consistent system.
const REVENUE_COLOR = "#2a78d6";
const EXPENSES_COLOR = "#eb6834";
const WASTAGE_COLOR = "#a13d3d";
const SECONDARY_TEXT_COLOR = "#52514e";

type ReportSummary = {
  range: { from: string; to: string };
  /** The branch this summary is scoped to (header's BranchSwitcher), or
   *  null when it's restaurant-wide ("All branches"). */
  branchId: string | null;
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
  /** P2 — cost of goods sold, from recipe-tracked ingredient cost per
   *  order sold. Deliberately separate from netProfitInPaisa — see
   *  getCogsSummary's doc comment in reports.ts for why. */
  cogsInPaisa: number;
  grossProfitInPaisa: number;
  /** null when revenue is 0 for the range (no meaningful margin). */
  grossMarginPercent: number | null;
  /** How many distinct menu items sold in the range have a recipe defined
   *  vs. how many were sold at all — when these differ, cogsInPaisa is a
   *  partial total, not a complete one, and the UI says so. */
  cogsCoverage: { soldItemCount: number; itemsWithRecipeCount: number };
  /** P2 — ingredient cost of stock logged as "waste" in the range, valued
   *  at each item's own cost basis. Separate from cogsInPaisa — waste
   *  never generated revenue, so it isn't "cost of goods SOLD". */
  wastageCostInPaisa: number;
  wastageMovementCount: number;
  wastageByReason: { reason: WasteReasonValue; costInPaisa: number; movementCount: number }[];
  dailySeries: DailySeriesPoint[];
  topItems: { name: string; quantitySold: number; revenueInPaisa: number }[];
  paymentBreakdown: { method: PaymentMethod; totalInPaisa: number }[];
  expenseBreakdown: { category: string; totalInPaisa: number }[];
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
  /** Commercial Launch Phase B.1 — stage-by-stage timing built from the new
   *  order_status_history table, a more precise sibling of `completion`
   *  above (which proxies off orders.updatedAt). */
  orderPerformance: {
    stageDurations: {
      fromStatus: OrderStatus;
      toStatus: OrderStatus;
      avgMinutes: number | null;
      transitionCount: number;
    }[];
    cancelledCount: number;
    cancellationRatePercent: number;
    avgMinutesBeforeCancellation: number | null;
    cancellationReasons: { reason: string; count: number }[];
  };
};

// UTC hour-of-day -> a readable 12-hour label. Matches the same UTC
// simplification documented in reports.ts's dayBounds() comment.
function formatHour(hour: number | null) {
  if (hour === null) return "—";
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour} ${period}`;
}

// Used both for the "compared against previous X–Y" summary text below and
// (via RevenueTrendChart, which takes the same `system` param) the trend
// chart's x-axis ticks, so the whole Reports screen follows one AD/BS
// preference rather than the chart and the surrounding copy disagreeing.
function formatShortDate(iso: string, system: DateSystem) {
  if (system === "BS") return formatDate(`${iso}T00:00:00`, "BS");
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
  return localDateIso();
}

function daysAgoIso(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateIso(d);
}

function firstOfMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// Presets before a custom range — dataviz skill's "date range first, presets
// before custom range" rule.
const PRESETS = [
  { label: "Today", from: () => todayIso(), to: () => todayIso() },
  { label: "Last 7 days", from: () => daysAgoIso(6), to: () => todayIso() },
  { label: "Last 30 days", from: () => daysAgoIso(29), to: () => todayIso() },
  { label: "This month", from: () => firstOfMonthIso(), to: () => todayIso() },
] as const;

type ProductProfitabilityRow = {
  name: string;
  quantitySold: number;
  revenueInPaisa: number;
  cogsInPaisa: number;
  grossProfitInPaisa: number;
  marginPercent: number | null;
  hasFullCostCoverage: boolean;
};

type ProfitabilitySortKey = "revenue" | "quantity" | "cogs" | "grossProfit" | "margin";

export function ReportsBoard({ slug, canViewProfit }: { slug: string; canViewProfit: boolean }) {
  const [from, setFrom] = useState(daysAgoIso(29));
  const [to, setTo] = useState(todayIso());
  const [activePreset, setActivePreset] = useState<string | null>("Last 30 days");
  const [data, setData] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductProfitabilityRow[] | null>(null);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<ProfitabilitySortKey>("revenue");
  const [sortDesc, setSortDesc] = useState(true);
  const dateSystem = useDateSystem();
  // Header's BranchSwitcher — see BranchProvider's own comment for why this
  // is a client-side context read rather than a prop threaded down from the
  // server page, and why changing it here just refetches rather than
  // navigating anywhere.
  const { branches, activeBranchId } = useActiveBranch();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ from, to });
        if (activeBranchId) params.set("branchId", activeBranchId);
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
  }, [slug, from, to, activeBranchId]);

  // Fetched separately from the main summary (its own loading/error state)
  // since it's gated behind VIEW_PROFIT specifically — a role that can see
  // this Reports page (VIEW_REPORTS) but not profit data never issues this
  // request at all, avoiding a guaranteed 403 for them.
  useEffect(() => {
    if (!canViewProfit) {
      setProductsLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setProductsLoading(true);
      try {
        const params = new URLSearchParams({ from, to });
        if (activeBranchId) params.set("branchId", activeBranchId);
        const res = await apiGet<{ products: ProductProfitabilityRow[] }>(
          `${base(slug)}/reports/product-profitability?${params}`,
        );
        if (!cancelled) {
          setProducts(res.products);
          setProductsError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setProductsError(err instanceof ApiError ? err.message : "Could not load product profitability.");
        }
      } finally {
        if (!cancelled) setProductsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [slug, from, to, activeBranchId, canViewProfit]);

  const sortedProducts = useMemo(() => {
    if (!products) return [];
    const key: Record<ProfitabilitySortKey, (r: ProductProfitabilityRow) => number> = {
      revenue: (r) => r.revenueInPaisa,
      quantity: (r) => r.quantitySold,
      cogs: (r) => r.cogsInPaisa,
      grossProfit: (r) => r.grossProfitInPaisa,
      margin: (r) => r.marginPercent ?? -Infinity,
    };
    const pick = key[sortKey];
    return [...products].sort((a, b) => (sortDesc ? pick(b) - pick(a) : pick(a) - pick(b)));
  }, [products, sortKey, sortDesc]);

  function toggleSort(key: ProfitabilitySortKey) {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

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
  const maxWastageTotal = useMemo(
    () => Math.max(1, ...(data?.wastageByReason.map((r) => r.costInPaisa) ?? [1])),
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
        {branches.length > 1 && (
          <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
            {activeBranchId
              ? branches.find((b) => b.id === activeBranchId)?.name ?? "Branch"
              : "All branches"}
          </span>
        )}
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
            {dateSystem === "BS" && (
              <span className="text-xs text-neutral-400">{formatBsHint(from)}</span>
            )}
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
            {dateSystem === "BS" && <span className="text-xs text-neutral-400">{formatBsHint(to)}</span>}
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
              previous {formatShortDate(data.comparison.previousRange.from, dateSystem)} –{" "}
              {formatShortDate(data.comparison.previousRange.to, dateSystem)} (same length as the
              selected range).
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
                label="Cost of goods sold"
                value={formatRupees(data.cogsInPaisa)}
                icon={<StatIcon.TrendDown />}
                color="neutral"
              />
              <IconStatTile
                label="Gross profit"
                value={formatRupees(data.grossProfitInPaisa)}
                icon={<StatIcon.TrendUp />}
                color={data.grossProfitInPaisa < 0 ? "red" : "teal"}
                tone={data.grossProfitInPaisa < 0 ? "negative" : "neutral"}
              />
              <IconStatTile
                label="Wastage cost"
                value={formatRupees(data.wastageCostInPaisa)}
                note={
                  data.wastageMovementCount > 0
                    ? `${data.wastageMovementCount} recorded`
                    : "None recorded"
                }
                icon={<StatIcon.TrendDown />}
                color={data.wastageCostInPaisa > 0 ? "red" : "neutral"}
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

            {data.cogsCoverage.soldItemCount > 0 &&
              data.cogsCoverage.itemsWithRecipeCount < data.cogsCoverage.soldItemCount && (
                <p className="-mt-4 mb-6 text-xs text-amber-700">
                  Cost of goods sold and gross profit only reflect{" "}
                  {data.cogsCoverage.itemsWithRecipeCount} of {data.cogsCoverage.soldItemCount} menu
                  items sold in this range — the rest have no recipe defined yet (Inventory →
                  Recipes), so their ingredient cost isn&apos;t counted.
                </p>
              )}

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

            {/* Order Performance (Commercial Launch Phase B.1) — how long an
                order actually spends in each kitchen/service stage, built
                from the order_status_history table (a more precise sibling
                of the "Avg. completion time" tile above). */}
            <div className="mb-6 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-neutral-900">Order stage timing</h2>
              <OrderStageDurations stageDurations={data.orderPerformance.stageDurations} />

              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <IconStatTile
                  label="Cancellation rate"
                  value={`${data.orderPerformance.cancellationRatePercent}%`}
                  note={`${data.orderPerformance.cancelledCount} orders`}
                  icon={<StatIcon.CheckCircle />}
                  color={data.orderPerformance.cancellationRatePercent <= 5 ? "green" : "amber"}
                />
                <IconStatTile
                  label="Avg. time before cancelling"
                  value={formatMinutes(data.orderPerformance.avgMinutesBeforeCancellation)}
                  note="Placed → cancelled"
                  icon={<StatIcon.Clock />}
                  color="amber"
                />
              </div>

              {data.orderPerformance.cancellationReasons.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Cancellation reasons
                  </p>
                  <ul className="space-y-1 text-sm text-neutral-700">
                    {data.orderPerformance.cancellationReasons.map((r) => (
                      <li key={r.reason} className="flex items-center justify-between">
                        <span>{r.reason}</span>
                        <span className="font-medium text-neutral-900">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 xl:grid-cols-4">
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
                        label={row.category}
                        valueLabel={formatRupees(row.totalInPaisa)}
                        fraction={row.totalInPaisa / maxExpenseTotal}
                        color={EXPENSES_COLOR}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Wastage breakdown by reason — P2, see getWastageSummary */}
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm lg:col-span-1">
                <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                  Wastage by reason
                </h2>
                {data.wastageByReason.length === 0 ? (
                  <p className="text-sm text-neutral-400">No wastage recorded in this range.</p>
                ) : (
                  <div className="space-y-2.5">
                    {data.wastageByReason.map((row) => (
                      <BreakdownBar
                        key={row.reason}
                        label={WASTE_REASON_LABELS[row.reason]}
                        valueLabel={formatRupees(row.costInPaisa)}
                        fraction={row.costInPaisa / maxWastageTotal}
                        color={WASTAGE_COLOR}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {canViewProfit && (
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                <h2 className="mb-3 text-sm font-semibold text-neutral-900">Product-level profitability</h2>
                {productsError && (
                  <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{productsError}</p>
                )}
                {productsLoading ? (
                  <p className="text-sm text-neutral-400">Loading…</p>
                ) : !products || products.length === 0 ? (
                  <p className="text-sm text-neutral-400">No completed orders in this range.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
                        <tr>
                          <th className="pb-2">Item</th>
                          <ProfitabilitySortHeader label="Qty" sortKeyName="quantity" {...{ sortKey, sortDesc, toggleSort }} />
                          <ProfitabilitySortHeader label="Revenue" sortKeyName="revenue" {...{ sortKey, sortDesc, toggleSort }} />
                          <ProfitabilitySortHeader label="COGS" sortKeyName="cogs" {...{ sortKey, sortDesc, toggleSort }} />
                          <ProfitabilitySortHeader label="Gross profit" sortKeyName="grossProfit" {...{ sortKey, sortDesc, toggleSort }} />
                          <ProfitabilitySortHeader label="Margin" sortKeyName="margin" {...{ sortKey, sortDesc, toggleSort }} />
                        </tr>
                      </thead>
                      <tbody>
                        {sortedProducts.map((row) => (
                          <tr key={row.name} className="border-t border-neutral-100">
                            <td className="py-1.5 text-neutral-800">
                              {row.name}
                              {!row.hasFullCostCoverage && (
                                <span
                                  className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700"
                                  title="At least one unit sold in this range had no recipe defined — COGS/margin here is a partial figure, not the full cost."
                                >
                                  Partial cost
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 text-right text-neutral-600">{row.quantitySold}</td>
                            <td className="py-1.5 text-right text-neutral-900">{formatRupees(row.revenueInPaisa)}</td>
                            <td className="py-1.5 text-right text-neutral-600">{formatRupees(row.cogsInPaisa)}</td>
                            <td
                              className={`py-1.5 text-right font-medium ${
                                row.grossProfitInPaisa < 0 ? "text-red-700" : "text-neutral-900"
                              }`}
                            >
                              {formatRupees(row.grossProfitInPaisa)}
                            </td>
                            <td className="py-1.5 text-right text-neutral-600">
                              {row.marginPercent === null ? "—" : `${row.marginPercent.toFixed(1)}%`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
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

/** Commercial Launch Phase B.1 — reuses BreakdownBar (already built for the
 *  payment/expense breakdowns above) to show average time-in-stage as a
 *  row of bars scaled against the SLOWEST stage present, so the one worth
 *  looking at first (usually kitchen prep) visually stands out. A stage
 *  with zero transitions in range is shown with a "—" rather than omitted
 *  — its absence from the list would otherwise read as "instant". */
function OrderStageDurations({
  stageDurations,
}: {
  stageDurations: {
    fromStatus: OrderStatus;
    toStatus: OrderStatus;
    avgMinutes: number | null;
    transitionCount: number;
  }[];
}) {
  const maxMinutes = Math.max(1, ...stageDurations.map((s) => s.avgMinutes ?? 0));
  return (
    <div className="space-y-3">
      {stageDurations.map((s) => (
        <BreakdownBar
          key={`${s.fromStatus}-${s.toStatus}`}
          label={`${ORDER_STATUS_LABELS[s.fromStatus]} → ${ORDER_STATUS_LABELS[s.toStatus]}`}
          valueLabel={
            s.avgMinutes !== null
              ? `${formatMinutes(s.avgMinutes)} (${s.transitionCount} order${s.transitionCount === 1 ? "" : "s"})`
              : "—"
          }
          fraction={s.avgMinutes !== null ? s.avgMinutes / maxMinutes : 0}
          color={REVENUE_COLOR}
        />
      ))}
    </div>
  );
}

/** A clickable column header for the product-profitability table — click
 * toggles ascending/descending on that column, matching the master
 * prompt's "sortable" requirement without needing server-side sort params
 * (every field the UI could sort by is already present in each row). */
function ProfitabilitySortHeader({
  label,
  sortKeyName,
  sortKey,
  sortDesc,
  toggleSort,
}: {
  label: string;
  sortKeyName: ProfitabilitySortKey;
  sortKey: ProfitabilitySortKey;
  sortDesc: boolean;
  toggleSort: (key: ProfitabilitySortKey) => void;
}) {
  const active = sortKey === sortKeyName;
  return (
    <th className="pb-2 text-right">
      <button
        type="button"
        onClick={() => toggleSort(sortKeyName)}
        className={`inline-flex items-center gap-0.5 ${active ? "text-neutral-900" : "text-neutral-500"} hover:text-neutral-900`}
      >
        {label}
        {active && <span className="text-[10px]">{sortDesc ? "▼" : "▲"}</span>}
      </button>
    </th>
  );
}
