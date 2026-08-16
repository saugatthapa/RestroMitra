"use client";

import { useMemo, useState } from "react";
import type { DailySeriesPoint } from "@/lib/reports-helpers";

// Validated categorical palette (dataviz skill, references/palette.md) —
// slot 1 (blue) for revenue, slot 2 (orange) for expenses. This app ships
// a single light theme only (see globals.css), so only the light-mode
// steps are used here.
const REVENUE_COLOR = "#2a78d6";
const EXPENSES_COLOR = "#eb6834";
const GRIDLINE_COLOR = "#e1e0d9";
const AXIS_TEXT_COLOR = "#898781";
const PRIMARY_TEXT_COLOR = "#0b0b0b";
const SECONDARY_TEXT_COLOR = "#52514e";

const WIDTH = 800;
const HEIGHT = 260;
const PADDING = { top: 16, right: 16, bottom: 28, left: 84 };

// No "Rs" prefix here — the y-axis is entirely money (chart title + tooltip
// already say so), and the prefix pushed wide figures (six-digit rupee
// totals) past the left edge of the SVG viewBox, silently clipping the
// leading digit/currency mark. Bare thousands-separated numbers stay
// readable at any range length.
function formatAxisRupees(paisa: number) {
  const rupees = Math.round(paisa / 100);
  return rupees.toLocaleString("en-IN");
}

function formatTooltipRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function formatShortDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Smallest "nice" (1/2/5 × 10^n) number >= value, for clean axis ticks. */
function niceCeiling(value: number): number {
  if (value <= 0) return 100;
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  const fraction = value / base;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * base;
}

export function RevenueTrendChart({ series }: { series: DailySeriesPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const maxValue = useMemo(() => {
    const max = Math.max(1, ...series.flatMap((p) => [p.revenueInPaisa, p.expensesInPaisa]));
    return niceCeiling(max);
  }, [series]);

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const xForIndex = (i: number) =>
    series.length <= 1
      ? PADDING.left + plotWidth / 2
      : PADDING.left + (i / (series.length - 1)) * plotWidth;
  const yForValue = (v: number) => PADDING.top + plotHeight - (v / maxValue) * plotHeight;

  const revenuePath = series
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xForIndex(i)} ${yForValue(p.revenueInPaisa)}`)
    .join(" ");
  const expensesPath = series
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xForIndex(i)} ${yForValue(p.expensesInPaisa)}`)
    .join(" ");
  // A soft gradient fill under the Revenue line only (not Expenses — two
  // overlapping fills would just muddy each other) — visual richness
  // without crossing into the dual-axis anti-pattern; still one scale, one
  // set of gridlines, same line+crosshair interaction as before.
  const revenueAreaPath =
    series.length > 0
      ? `${revenuePath} L ${xForIndex(series.length - 1)} ${yForValue(0)} L ${xForIndex(0)} ${yForValue(0)} Z`
      : "";

  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (maxValue / tickCount) * i);

  // Show at most ~8 x-axis date labels regardless of range length, so a
  // 90-day range doesn't collide into unreadable text.
  const labelEvery = Math.max(1, Math.ceil(series.length / 8));

  function handlePointerMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relativeX = e.clientX - rect.left;
    const ratio = plotWidth === 0 ? 0 : (relativeX * (WIDTH / rect.width) - PADDING.left) / plotWidth;
    const index = Math.round(ratio * (series.length - 1));
    setHoverIndex(Math.min(series.length - 1, Math.max(0, index)));
  }

  const hovered = hoverIndex !== null ? series[hoverIndex] : null;

  if (series.length === 0) {
    return <p className="text-sm text-neutral-400">No data for this range.</p>;
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded-full" style={{ backgroundColor: REVENUE_COLOR }} />
            <span style={{ color: SECONDARY_TEXT_COLOR }}>Revenue</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded-full" style={{ backgroundColor: EXPENSES_COLOR }} />
            <span style={{ color: SECONDARY_TEXT_COLOR }}>Expenses</span>
          </span>
        </div>
        <button
          onClick={() => setShowTable((v) => !v)}
          className="text-xs font-medium text-orange-700 hover:underline"
        >
          {showTable ? "Show chart" : "Show as table"}
        </button>
      </div>

      {showTable ? (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Revenue</th>
                <th className="px-3 py-2">Expenses</th>
              </tr>
            </thead>
            <tbody>
              {series.map((p) => (
                <tr key={p.date} className="border-t border-neutral-100">
                  <td className="px-3 py-1.5">{p.date}</td>
                  <td className="px-3 py-1.5">{formatTooltipRupees(p.revenueInPaisa)}</td>
                  <td className="px-3 py-1.5">{formatTooltipRupees(p.expensesInPaisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Revenue vs expenses over time">
            <defs>
              <linearGradient id="revenue-area-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={REVENUE_COLOR} stopOpacity={0.16} />
                <stop offset="100%" stopColor={REVENUE_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* Gridlines + y-axis ticks */}
            {ticks.map((tick, i) => {
              const y = yForValue(tick);
              return (
                <g key={i}>
                  <line
                    x1={PADDING.left}
                    x2={WIDTH - PADDING.right}
                    y1={y}
                    y2={y}
                    stroke={GRIDLINE_COLOR}
                    strokeWidth={1}
                  />
                  <text x={PADDING.left - 8} y={y + 4} textAnchor="end" fontSize={11} fill={AXIS_TEXT_COLOR}>
                    {formatAxisRupees(tick)}
                  </text>
                </g>
              );
            })}

            {/* X-axis date labels */}
            {series.map((p, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={p.date}
                  x={xForIndex(i)}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize={11}
                  fill={AXIS_TEXT_COLOR}
                >
                  {formatShortDate(p.date)}
                </text>
              ) : null,
            )}

            {/* Revenue area fill (under the line, before it's drawn) */}
            <path d={revenueAreaPath} fill="url(#revenue-area-gradient)" stroke="none" />

            {/* Lines */}
            <path d={revenuePath} fill="none" stroke={REVENUE_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <path d={expensesPath} fill="none" stroke={EXPENSES_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

            {/* End-point markers with a surface ring */}
            {series.length > 0 && (
              <>
                <circle cx={xForIndex(series.length - 1)} cy={yForValue(series[series.length - 1].revenueInPaisa)} r={4} fill={REVENUE_COLOR} stroke="#fcfcfb" strokeWidth={2} />
                <circle cx={xForIndex(series.length - 1)} cy={yForValue(series[series.length - 1].expensesInPaisa)} r={4} fill={EXPENSES_COLOR} stroke="#fcfcfb" strokeWidth={2} />
              </>
            )}

            {/* Crosshair */}
            {hoverIndex !== null && (
              <line
                x1={xForIndex(hoverIndex)}
                x2={xForIndex(hoverIndex)}
                y1={PADDING.top}
                y2={HEIGHT - PADDING.bottom}
                stroke={AXIS_TEXT_COLOR}
                strokeWidth={1}
                strokeDasharray="3,3"
              />
            )}
            {hovered && hoverIndex !== null && (
              <>
                <circle cx={xForIndex(hoverIndex)} cy={yForValue(hovered.revenueInPaisa)} r={4} fill={REVENUE_COLOR} stroke="#fcfcfb" strokeWidth={2} />
                <circle cx={xForIndex(hoverIndex)} cy={yForValue(hovered.expensesInPaisa)} r={4} fill={EXPENSES_COLOR} stroke="#fcfcfb" strokeWidth={2} />
              </>
            )}

            {/* Hover hit target — covers the whole plot area, bigger than any mark */}
            <rect
              x={PADDING.left}
              y={PADDING.top}
              width={plotWidth}
              height={plotHeight}
              fill="transparent"
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setHoverIndex(null)}
            />
          </svg>

          {hovered && (
            <div
              className="pointer-events-none absolute top-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs shadow-md"
              style={{
                left: `${Math.min(85, Math.max(5, (xForIndex(hoverIndex!) / WIDTH) * 100))}%`,
              }}
            >
              <p className="mb-1 font-medium" style={{ color: PRIMARY_TEXT_COLOR }}>
                {formatShortDate(hovered.date)}
              </p>
              <p className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: REVENUE_COLOR }} />
                <span style={{ color: SECONDARY_TEXT_COLOR }}>Revenue</span>
                <strong style={{ color: PRIMARY_TEXT_COLOR }}>{formatTooltipRupees(hovered.revenueInPaisa)}</strong>
              </p>
              <p className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: EXPENSES_COLOR }} />
                <span style={{ color: SECONDARY_TEXT_COLOR }}>Expenses</span>
                <strong style={{ color: PRIMARY_TEXT_COLOR }}>{formatTooltipRupees(hovered.expensesInPaisa)}</strong>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
