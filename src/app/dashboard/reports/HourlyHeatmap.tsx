"use client";

import { useMemo, useState } from "react";
import { formatNPR } from "@/lib/money";

export type HourlyHeatmapCell = {
  dayOfWeek: number;
  hour: number;
  orderCount: number;
  revenueInPaisa: number;
};

// Sequential blue ramp, light -> dark (dataviz skill, references/palette.md
// "Sequential hue"). Same blue already used for Revenue elsewhere in
// Reports (RevenueTrendChart, the Revenue stat tile) — one hue, magnitude
// only, never a rainbow.
const SEQUENTIAL_STEPS = [
  "#cde2fb",
  "#b7d3f6",
  "#9ec5f4",
  "#86b6ef",
  "#6da7ec",
  "#5598e7",
  "#3987e5",
  "#2a78d6",
  "#256abf",
  "#1c5cab",
  "#184f95",
  "#104281",
  "#0d366b",
];
const EMPTY_CELL_COLOR = "#f0efec"; // neutral surface — "no orders", not "lowest step"

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function formatHour(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour} ${period}`;
}

function colorForRatio(ratio: number): string {
  const index = Math.min(
    SEQUENTIAL_STEPS.length - 1,
    Math.round(ratio * (SEQUENTIAL_STEPS.length - 1)),
  );
  return SEQUENTIAL_STEPS[index];
}

type Metric = "orders" | "revenue";

/**
 * Phase 17 — an hour-by-day-of-week grid (7 rows x 24 columns), a
 * finer-grained sibling of the single "peak hour" stat tile already on
 * this page. Built as plain divs on a CSS grid rather than SVG — with 168
 * cells, per-cell hover tooltips and a real <table> fallback are simpler
 * to get right this way, and there's no continuous line/path geometry
 * that would benefit from SVG.
 */
export function HourlyHeatmap({ cells }: { cells: HourlyHeatmapCell[] }) {
  const [metric, setMetric] = useState<Metric>("orders");
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  const grid = useMemo(() => {
    const byKey = new Map(cells.map((c) => [`${c.dayOfWeek}-${c.hour}`, c]));
    return DAY_LABELS.map((_, dayOfWeek) =>
      HOURS.map((hour) => byKey.get(`${dayOfWeek}-${hour}`) ?? { dayOfWeek, hour, orderCount: 0, revenueInPaisa: 0 }),
    );
  }, [cells]);

  const maxValue = useMemo(() => {
    const values = cells.map((c) => (metric === "orders" ? c.orderCount : c.revenueInPaisa));
    return Math.max(1, ...values);
  }, [cells, metric]);

  const nonZeroCells = useMemo(
    () =>
      [...cells]
        .filter((c) => c.orderCount > 0)
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour),
    [cells],
  );

  const hovered = hoverKey
    ? cells.find((c) => `${c.dayOfWeek}-${c.hour}` === hoverKey)
    : null;

  if (cells.length === 0) {
    return <p className="text-sm text-neutral-400">No completed orders in this range yet.</p>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 p-0.5 text-xs">
          <button
            onClick={() => setMetric("orders")}
            className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
              metric === "orders" ? "bg-white text-orange-700 shadow-sm" : "text-neutral-500"
            }`}
          >
            By orders
          </button>
          <button
            onClick={() => setMetric("revenue")}
            className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
              metric === "revenue" ? "bg-white text-orange-700 shadow-sm" : "text-neutral-500"
            }`}
          >
            By revenue
          </button>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            <span>Fewer</span>
            <span className="flex h-2.5 w-20 overflow-hidden rounded-full">
              {SEQUENTIAL_STEPS.map((step) => (
                <span key={step} className="h-full flex-1" style={{ backgroundColor: step }} />
              ))}
            </span>
            <span>More</span>
          </div>
          <button
            onClick={() => setShowTable((v) => !v)}
            className="text-xs font-medium text-orange-700 hover:underline"
          >
            {showTable ? "Show heatmap" : "Show as table"}
          </button>
        </div>
      </div>

      {showTable ? (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2">Hour</th>
                <th className="px-3 py-2">Orders</th>
                <th className="px-3 py-2">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {nonZeroCells.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-center text-neutral-400">
                    No completed orders in this range yet.
                  </td>
                </tr>
              ) : (
                nonZeroCells.map((c) => (
                  <tr key={`${c.dayOfWeek}-${c.hour}`} className="border-t border-neutral-100">
                    <td className="px-3 py-1.5">{DAY_LABELS[c.dayOfWeek]}</td>
                    <td className="px-3 py-1.5">{formatHour(c.hour)}</td>
                    <td className="px-3 py-1.5">{c.orderCount}</td>
                    <td className="px-3 py-1.5">{formatNPR(c.revenueInPaisa)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative overflow-x-auto">
          <div className="min-w-[640px]">
            {/* Hour axis — labeled every 3 hours to stay legible across 24 columns */}
            <div className="mb-1 grid grid-cols-[36px_repeat(24,1fr)] gap-[2px] pl-0">
              <div />
              {HOURS.map((hour) => (
                <div key={hour} className="text-center text-[9px] text-neutral-400">
                  {hour % 3 === 0 ? formatHour(hour).replace(" ", "") : ""}
                </div>
              ))}
            </div>

            {grid.map((row, dayOfWeek) => (
              <div key={dayOfWeek} className="mb-[2px] grid grid-cols-[36px_repeat(24,1fr)] gap-[2px]">
                <div className="flex items-center text-[11px] text-neutral-500">
                  {DAY_LABELS[dayOfWeek]}
                </div>
                {row.map((cell) => {
                  const value = metric === "orders" ? cell.orderCount : cell.revenueInPaisa;
                  const ratio = value === 0 ? 0 : value / maxValue;
                  const key = `${cell.dayOfWeek}-${cell.hour}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      className="aspect-square rounded-[3px] ring-1 ring-inset ring-white/60 transition-transform hover:scale-110 hover:ring-2 hover:ring-orange-500"
                      style={{ backgroundColor: value === 0 ? EMPTY_CELL_COLOR : colorForRatio(ratio) }}
                      onMouseEnter={() => setHoverKey(key)}
                      onMouseLeave={() => setHoverKey((k) => (k === key ? null : k))}
                      onFocus={() => setHoverKey(key)}
                      onBlur={() => setHoverKey((k) => (k === key ? null : k))}
                      aria-label={`${DAY_LABELS[cell.dayOfWeek]} ${formatHour(cell.hour)}: ${cell.orderCount} order${cell.orderCount === 1 ? "" : "s"}, ${formatNPR(cell.revenueInPaisa)}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>

          {hovered && (
            <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs shadow-md">
              <p className="mb-1 font-medium text-neutral-900">
                {DAY_LABELS[hovered.dayOfWeek]} · {formatHour(hovered.hour)}
              </p>
              <p className="text-neutral-500">
                {hovered.orderCount} order{hovered.orderCount === 1 ? "" : "s"} ·{" "}
                <strong className="text-neutral-900">{formatNPR(hovered.revenueInPaisa)}</strong>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
