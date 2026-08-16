# Phase 16 — Dashboard analytics polish (peak hours, completion rate) + visual unification

Scope: the user sent a screenshot of a third-party restaurant dashboard
("RestroHub"/"Cafe Pink Floyd" branding — unrelated to DhankiPOS) and asked
for a UI "better than image i have send to you." That reference dashboard
showed icon-chip stat tiles, a dual-axis revenue/orders/avg-order chart, and
peak-hour/completion-rate metric tiles. This phase delivers the same
*category* of information with better execution, not a literal copy of its
layout — see the dual-axis decision below.

## Why this matters

The dashboard landing page had drifted stale (a hardcoded "Low-stock items:
0" placeholder left over from before inventory existed, a roadmap list stuck
referencing "Phase 11" while Phases 12–15 had already shipped), and the two
places KPI tiles appear (`dashboard/page.tsx` and `reports/ReportsBoard.tsx`)
had grown two subtly different card styles independently. This phase both
adds the new analytics the user asked to see and cleans up that drift as
part of touching the same surface area.

## What's done and verified

- **A deliberate, explained deviation from the reference screenshot**: the
  reference dashboard's headline chart plots Revenue (₹) and Orders (count)
  on two different y-axes of the same line chart. A dual-axis chart is
  flagged as the **#1 chart anti-pattern** in this project's own dataviz
  skill reference (two measures of different scale must be two charts, small
  multiples, or indexed to a common base — never one chart with two scales,
  because the visual relationship between the two lines becomes whatever the
  axis ranges happen to make it look like, not the real relationship in the
  data). Building it anyway just to visually match the screenshot would have
  been building something this project's own standards call incorrect.
  Instead: peak-hour and completion-rate are surfaced as plain, unambiguous
  number tiles (exactly what the reference screenshot *also* does for its
  bottom-row "Peak Hour Orders / Peak Hour Sales / Avg Completion / Completion
  Rate" tiles — that part of the reference *is* good practice and was kept),
  and the existing single-axis revenue/expenses trend chart (Phase 9) is left
  as the trend visualization, unchanged.
- **New report functions** (`src/lib/reports.ts`):
  - `getPeakHourStats(restaurantId, range)` — buckets completed orders by
    UTC hour-of-day (`extract(hour from placedAt at time zone 'UTC')`,
    the same UTC-calendar-day simplification already documented and used by
    every other function in this file — `restaurants.timezone` exists but
    isn't threaded through yet) and returns both the busiest hour by order
    count and, independently, the busiest hour by revenue (they don't have
    to agree — a fast lunch rush can win on count while one big evening
    party wins on revenue).
  - `getCompletionStats(restaurantId, range)` — `completionRatePercent` is
    paid ÷ total non-cancelled orders × 100 (0, not null, when there are no
    orders — "0 of 0" reads as 0%, not "unknown"). `avgCompletionMinutes` is
    the average `updatedAt − placedAt` (in minutes) across orders currently
    `completed` — **explicitly documented in-code as an approximation**:
    there is no dedicated `completedAt` timestamp column on `orders` (see
    `schema.ts`), so this reads `updatedAt`, which reflects whichever write
    most recently touched the row. In the overwhelming common case that's
    the status transition into `completed`, but a discount/service-charge
    edit applied *after* completion (the adjustments route only blocks
    cancelled orders, not completed ones) would also bump `updatedAt` and
    skew this number. Flagged as a known limitation, not silently assumed
    precise.
  - Both are wired into `getReportSummary()`'s existing `Promise.all` (same
    pattern as the Phase 13 `getTipsSummary` addition) so the whole Reports
    page and the AI assistant get every number from one consistent request/
    snapshot in time.
- **`buildSystemPrompt()` widened** (`src/lib/ai/assistant.ts`) to include
  the new peak-hour/completion figures, plus the Phase 13 discount/service-
  charge/tips figures that existed in `ReportSummary` but were never
  actually surfaced to the assistant before this phase — so "what's my
  busiest hour" or "how's my completion rate" are now answerable questions,
  not just sales/expenses/top-items.
- **Real low-stock count on the dashboard landing page**, replacing the
  hardcoded `"0"` placeholder: reuses the existing `isLowStock()` pure
  function from `src/lib/inventory.ts` (the same one the inventory API route
  already uses) against the restaurant's active inventory items, so the
  dashboard tile and the inventory page can never disagree on what "low"
  means. Verified live: created a fresh inventory item at 0 stock with a
  reorder level of 5kg (a new item starts at 0 stock, so it's low-stock by
  definition), and confirmed via both a smoke-test HTML assertion and a
  Playwright screenshot that the tile flips from "0 / Everything is stocked"
  (green) to "1 / At or below reorder level" (red).
- **A shared icon-chip stat tile component** (`src/components/StatTile.tsx`,
  `IconStatTile` + a small hand-authored inline-SVG icon set — no new
  dependency for a dozen simple glyphs) replaces the two independent stat
  tile implementations that had grown apart. One consistent card style
  (`rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm`) is now
  used everywhere a KPI/stat tile appears — the dashboard landing page, every
  tile on the Reports board (including the filter-row and section cards,
  which previously used a plain `rounded-xl` with no shadow), and the two new
  peak-hour/completion tiles. Icon-chip colors are a small fixed set assigned
  by meaning (blue for a primary revenue/count figure, green/red for
  positive/negative money or status, amber for time-based figures, purple for
  discretionary/engagement figures like discounts and tips), not generated
  per-tile — consistent with the dataviz skill's "identity/status never
  rides on color alone" rule (every tile still pairs its chip with a text
  label).
- **Dashboard roadmap list brought current** — was stuck listing only
  through "Phase 11 (in progress)"; now correctly shows Phases 1–16 all
  marked done, matching what's actually shipped.
- **Unit tests**: the two new report functions inherited coverage the same
  way every other function in `reports.ts` does — through this phase's live
  smoke test (`scripts/smoke-test-phase16.sh`) hitting the real dev server
  and real Postgres, matching the established pattern for this file (there's
  no existing `reports.test.ts` with mocked DB calls for any function in this
  module — `getSalesSummary`, `getTopMenuItems`, etc. are all smoke-tested
  live the same way, not unit-tested with a fake DB).
- **Full regression pass**: `tsc --noEmit` clean, `eslint .` clean (0
  warnings after also cleaning up two pre-existing unused-variable warnings
  in the Phase 15 screenshot script), `vitest run` → 428/428 tests passing,
  `next build` production build succeeds.
- **Live smoke test** (`scripts/smoke-test-phase16.sh`, 9/9 assertions
  passing): creates real orders, walks them through the full
  confirmed→preparing→ready→served→completed lifecycle with real payments,
  and asserts the `reports/summary` API returns the correct peak hour (by
  both count and revenue), the correct completion rate with a mix of paid
  and unpaid orders (2 of 3 → 66.67%), a non-negative average completion
  time, and that the dashboard's HTML actually reflects a real low-stock
  item rather than the old hardcoded text.
- **Playwright screenshots** of the finished dashboard landing page and
  Reports board, visually confirming: icon-chip tiles throughout, real
  live numbers (not zeros), the peak-hour/completion-rate tile row, the
  single-axis revenue/expenses chart (no dual-axis anti-pattern), and the
  updated 16-phase roadmap.

## Known gaps / deliberately deferred

- `avgCompletionMinutes` is an approximation, not exact — see above. A
  dedicated `orders.completedAt` column (set once, on the transition into
  `completed`, never touched again) would make this exact; deferred because
  it's a schema migration + backfill decision, and the current approximation
  is clearly labeled rather than silently wrong.
- Peak-hour bucketing is UTC-calendar-hour, not the restaurant's local
  timezone — same simplification already present everywhere else in
  `reports.ts` (`restaurants.timezone` exists in the schema but isn't
  threaded through query logic yet). A restaurant far from UTC will see
  "peak hour" figures that are offset from their actual wall-clock peak
  hour until this is addressed project-wide.
- No day-of-week breakdown (only hour-of-day, summed across the whole date
  range) — could be a natural follow-up if owners want "which day, not just
  which hour."

## Next steps

- Thread `restaurants.timezone` through `dayBounds()`/hour-bucketing across
  `reports.ts` as one project-wide fix, rather than patching it
  function-by-function.
- Consider a dedicated `orders.completedAt` column if the
  `avgCompletionMinutes` approximation ever proves materially wrong in
  practice (e.g. restaurants that frequently edit discounts after
  completion).
