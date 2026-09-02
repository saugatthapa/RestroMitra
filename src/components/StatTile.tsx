// Shared icon-chip stat tile — one visual language for every KPI card in
// the app (dashboard landing page + Reports board), replacing the two
// slightly-different card styles that grew independently. Follows the
// dataviz skill's rule that identity/status never rides on color alone:
// every tile pairs its icon chip with a text label, and the chip colors
// are a small fixed set (not generated per-tile), reused consistently by
// meaning (blue = a primary count/revenue figure, green = positive money,
// red = negative/attention, amber = time, purple = engagement/tips).

type ChipColor = "blue" | "orange" | "green" | "red" | "purple" | "teal" | "amber" | "neutral";

const CHIP_STYLES: Record<ChipColor, { bg: string; fg: string }> = {
  blue: { bg: "#e8f0fc", fg: "#2a78d6" },
  orange: { bg: "#fdece3", fg: "#eb6834" },
  green: { bg: "#e6f4ea", fg: "#1a7f37" },
  red: { bg: "#fbe9e7", fg: "#b3261e" },
  purple: { bg: "#f1e9fb", fg: "#7c3aed" },
  teal: { bg: "#e1f5f3", fg: "#0f766e" },
  amber: { bg: "#fef3e0", fg: "#b45309" },
  neutral: { bg: "#f0efed", fg: "#52514e" },
};

/**
 * Phase 16b — a "vs previous period" delta pill, requested directly by the
 * user via the reference dashboard screenshot's "+8.43% vs last month"
 * badge on its Orders tile. `goodDirection` flips the up=green/down=red
 * coloring for metrics where a decrease is the good outcome (none of the
 * current call sites need "down"; the param exists so a future
 * expenses-change tile doesn't have to invert the sign itself).
 * `percent === null` means the previous period had a zero baseline (see
 * percentChange()'s doc comment) — shown as "New" rather than a fabricated
 * "∞%" or a misleading 0%. `percent === 0` is a genuine "no change".
 */
export function DeltaLine({
  percent,
  goodDirection = "up",
  againstLabel = "vs previous period",
}: {
  percent: number | null;
  goodDirection?: "up" | "down";
  againstLabel?: string;
}) {
  if (percent === null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-faint">
        New <span className="font-normal">· no data in the previous period</span>
      </span>
    );
  }
  if (percent === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-faint">
        No change <span className="font-normal">· {againstLabel}</span>
      </span>
    );
  }
  const isUp = percent > 0;
  const isGood = goodDirection === "up" ? isUp : !isUp;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium ${isGood ? "text-green-400" : "text-red-400"}`}
    >
      {isUp ? "▲" : "▼"} {Math.abs(percent)}%
      <span className="font-normal text-ink-faint">{againstLabel}</span>
    </span>
  );
}

export function IconStatTile({
  label,
  value,
  note,
  icon,
  color = "neutral",
  tone = "neutral",
  delta,
}: {
  label: string;
  value: string;
  note?: string;
  icon: React.ReactNode;
  color?: ChipColor;
  tone?: "neutral" | "positive" | "negative";
  /** Renders a DeltaLine below the value in place of `note`. */
  delta?: { percent: number | null; goodDirection?: "up" | "down" };
}) {
  const chip = CHIP_STYLES[color];
  const valueColor = tone === "negative" ? "#b3261e" : "#0b0b0b";

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: chip.bg, color: chip.fg }}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-muted">{label}</p>
          <p className="mt-0.5 truncate text-lg font-semibold" style={{ color: valueColor }}>
            {value}
          </p>
        </div>
      </div>
      {delta ? (
        <div className="mt-2">
          <DeltaLine percent={delta.percent} goodDirection={delta.goodDirection} />
        </div>
      ) : (
        note && <p className="mt-2 text-xs text-ink-faint">{note}</p>
      )}
    </div>
  );
}

// Minimal hand-authored 20x20 stroke icon set — no new dependency for a
// handful of glyphs. Consistent 1.6 stroke weight, rounded caps/joins.
const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const StatIcon = {
  Rupee: () => (
    <svg {...iconProps}>
      <path d="M6 4h12M6 9h12M6 4c4.5 0 7 1.8 7 5s-2.5 5-7 5M6 14l8 7" />
    </svg>
  ),
  Receipt: () => (
    <svg {...iconProps}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" />
      <path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" />
    </svg>
  ),
  Calculator: () => (
    <svg {...iconProps}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16v3" />
    </svg>
  ),
  Wallet: () => (
    <svg {...iconProps}>
      <path d="M4 7a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v2" />
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M16 13.5h.01" />
    </svg>
  ),
  TrendUp: () => (
    <svg {...iconProps}>
      <path d="M4 16l6-6 4 4 6-8" />
      <path d="M14 6h6v6" />
    </svg>
  ),
  TrendDown: () => (
    <svg {...iconProps}>
      <path d="M4 8l6 6 4-4 6 8" />
      <path d="M14 18h6v-6" />
    </svg>
  ),
  Percent: () => (
    <svg {...iconProps}>
      <path d="M19 5L5 19" />
      <circle cx="7" cy="7" r="2.2" />
      <circle cx="17" cy="17" r="2.2" />
    </svg>
  ),
  Gift: () => (
    <svg {...iconProps}>
      <rect x="4" y="9" width="16" height="11" rx="1" />
      <path d="M4 13h16M12 9v11" />
      <path d="M12 9c-2 0-3.5-1-3.5-2.5S9.8 4 11 4c1.5 0 1 3 1 5zM12 9c2 0 3.5-1 3.5-2.5S14.2 4 13 4c-1.5 0-1 3-1 5z" />
    </svg>
  ),
  Clock: () => (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  ),
  CheckCircle: () => (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  ),
  Table: () => (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v12M19 8v12M9 8v12M15 8v12" />
    </svg>
  ),
  AlertTriangle: () => (
    <svg {...iconProps}>
      <path d="M12 4l9 16H3L12 4z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  ),
  Flame: () => (
    <svg {...iconProps}>
      <path d="M12 3c1 3-2 4-2 7a4 4 0 0 0 8 0c0-2-1-3-1-3s1 4-2 4c-2 0-2-2-1-4-2 0-3 2-3 4a5 5 0 0 0 10 0c0-5-4-6-4-8-1 1-1 1-1 0z" />
    </svg>
  ),
};
