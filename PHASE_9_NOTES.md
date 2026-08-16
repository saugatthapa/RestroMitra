# Phase 9 — Analytics & Reports

With Phase 8 complete (staff, attendance, expenses, customers, reservations,
loyalty), Phase 9 turns the raw transactional data those phases have been recording
into an actual owner/manager-facing reporting surface: a single Reports dashboard
covering sales, expenses, and profit for any date range.

## Competitive context

Per the standing instruction to build something better than existing Nepal
restaurant-SaaS competitors (e.g. restrohub.com.np): most of that tier ships either
no analytics at all or a static end-of-day sales total. This phase ships a real
date-range-scoped report — revenue vs. expenses trend, top-selling items, payment
method mix, and an expense category breakdown — all backed by one bundled API call
so every number on the page is guaranteed to reflect the exact same range (no risk
of two tiles racing against slightly different "now" boundaries on separate
requests).

## What's done and verified

- **`src/lib/reports-helpers.ts`** — pure, dependency-free math (no `server-only`,
  no DB import), same pattern as `order-status.ts`/`loyalty-tiers.ts`:
  `generateDateRange` (inclusive day list), `mergeDailySeries` (fills real zeros for
  days with no activity, so the chart never reads a quiet day as a data gap),
  `computeNetProfitInPaisa`, `computeAverageOrderValueInPaisa`.
- **`src/lib/reports.ts`** (`server-only`) — the actual aggregation queries:
  `getSalesSummary` (revenue = completed orders' `totalInPaisa`, same definition the
  live dashboard's "today's sales" tile already used — not payments received, not
  all non-cancelled orders), `getTotalExpensesInPaisa`, `getDailyRevenueVsExpenses`,
  `getTopMenuItems` (ranked by revenue, grouped by the order's own name *snapshot*
  so a since-renamed or deleted menu item still reports correctly under the name it
  had when each historical order was placed), `getPaymentMethodBreakdown` (sums the
  already-signed `amountInPaisa` column, so refunds net out of a method's total
  automatically — no separate subtraction needed), `getExpenseCategoryBreakdown`
  (excludes voided rows), and the bundling `getReportSummary` that runs all of the
  above via `Promise.all`. Every date-range query uses a half-open
  `[dayStart, dayAfterEnd)` window against `orders.placedAt`/`payments.createdAt`
  rather than a literal `<=` on the "to" day, so a timestamp exactly at midnight on
  the boundary is never ambiguously included or excluded.
- **`GET /api/restaurants/[slug]/reports/summary`** — the single endpoint the
  dashboard calls, gated behind `VIEW_REPORTS` (already in the permission catalog
  since Phase 1, granted to manager/owner only — no catalog change needed this
  phase, same profit-adjacent trust tier as `MANAGE_EXPENSES`). `?from=`/`?to=`
  (YYYY-MM-DD) scope the range; a malformed or backwards range, or one exceeding 366
  days, silently falls back to the trailing-30-day default rather than erroring — a
  bad query param shouldn't 400 a dashboard page load.
- **Hand-rolled SVG revenue-vs-expenses trend chart** (`RevenueTrendChart.tsx`) —
  no charting library in the project's dependencies, so this is a dependency-free
  client component built by directly following the `dataviz` skill's procedure:
  picked the form (multi-series line, single shared y-axis — money on both series
  makes a dual axis both unnecessary and against the skill's non-negotiable rule),
  assigned categorical color by identity (blue = revenue, orange = expenses) and ran
  the skill's palette validator script against that exact pair before using it (all
  checks passed — CVD ΔE 24.7, normal-vision ΔE 33.6, contrast ≥3:1), applied the
  mark specs (2px rounded lines, hairline recessive gridlines, 2px surface-color
  rings on point markers), and shipped the full hover layer the skill treats as
  part of the deliverable rather than an optional extra — a pointer-tracked
  crosshair + tooltip (values bold and leading, series names secondary, line-style
  swatches not boxes), a legend (always shown for 2 series), and a "Show as table"
  toggle as the accessibility-required non-chart fallback. One real bug caught and
  fixed during screenshot verification: the y-axis tick labels ("Rs 20,000" etc.)
  were being silently clipped at the SVG's left edge for wider figures because the
  left padding wasn't wide enough for the "Rs " prefix — fixed by widening the
  padding and dropping the redundant prefix from axis ticks (the chart title and
  tooltip already say it's money; the tooltip/table keep full "Rs X.XX" precision).
- **`ReportsBoard.tsx`** — the parent client component: a filter row above
  everything it scopes (date-range presets — Today / Last 7 days / Last 30 days /
  This month — listed before the custom from/to inputs, per the skill's "presets
  before custom range" rule), five KPI stat tiles (Revenue, Orders, Average order
  value, Total expenses, Net profit — net profit rendered in red when negative), the
  trend chart, a top-selling-items table, and payment-method/expense-category
  breakdowns as simple proportional bars sharing the same validated palette. A
  refetch on filter change holds the previous render at reduced opacity instead of
  flashing a skeleton, per the skill's "refetch keeps the frame" rule.
- **`/dashboard/reports`** — server component following the same
  auth/restaurant-resolution + `roleHasPermission(..., VIEW_REPORTS)` pattern as
  every other Phase 8 dashboard page, redirecting to `/dashboard` if the signed-in
  role doesn't hold `VIEW_REPORTS`. "Reports" flipped to enabled in the dashboard
  nav.
- **Tests**: `src/lib/reports-helpers.test.ts` (date-range generation including a
  single-day range, a backwards range, and a malformed-date guard; series merging;
  net profit; average-order-value rounding and its zero-order-count guard),
  `src/db/__tests__/reports-permissions.test.ts` — proves the `VIEW_REPORTS` split
  (manager/owner yes, cashier no), tenant isolation, and the actual aggregation math
  against real seeded orders/order_items/payments/expenses rows: only completed
  orders count as revenue, a cancelled order is excluded, a day-after-range order
  doesn't leak in (half-open boundary), a partial refund nets out of the payment
  breakdown automatically, and a voided expense is excluded from the category
  breakdown. 260 tests total after this phase (up from 235).
- **Live smoke test** (`scripts/smoke-test-phase9.sh`, 27 assertions, all passing):
  the `VIEW_REPORTS` permission split over real HTTP, two orders taken through the
  full `pending → ... → completed` lifecycle and paid (cash + card), a third order
  cancelled before completion, real expenses recorded via the actual expenses API,
  the summary endpoint's revenue/order-count/AOV/expenses/net-profit numbers
  matching hand-computed expectations exactly, the top-items ranking, the
  payment-method breakdown, the expense-category breakdown, the daily series, a
  partial refund correctly netting out of the card total while leaving revenue
  untouched (revenue is completed-order totals, not payments received), malformed
  and backwards date-range params falling back to the default instead of erroring,
  and cross-tenant isolation on both the endpoint and the underlying data.
- **Playwright screenshots** (`scripts/screenshot-phase9.mjs`, all entity names
  prefixed `Phase9Tour`) — seeded four completed orders across three menu items and
  three payment methods, plus three categorized expenses, then captured and
  visually verified: the full Reports overview (KPI tiles, trend chart, top items,
  payment/expense breakdowns), the chart's hover crosshair + tooltip, the "Show as
  table" fallback view, and the "Today" preset re-scoping every section at once
  (expenses correctly drop to zero for a range that excludes their expense date,
  proving the filter row's date-range scoping works end to end, not just for
  orders).

## Known gaps / deliberately deferred

- **Net profit is revenue minus expenses only — not a full COGS-based calculation.**
  Phase 7 built recipe/ingredient costing (`VIEW_PROFIT`, per-item margin), but this
  phase's "Net profit" tile doesn't pull ingredient cost data in; it's the simpler
  "money in minus recorded operating expenses" a small restaurant owner reads day to
  day, not a true gross-margin figure netting out cost of goods sold per item. A
  proper profitability report combining Phase 7's per-item costing with Phase 9's
  date-range revenue is a natural next slice once there's appetite for it.
- **Dates are UTC calendar days**, the same simplification flagged in the live
  dashboard's own "today's sales" tile comment since Phase 1 — the `restaurants`
  table has no timezone column threaded through yet, so a report run near midnight
  Nepal time (UTC+5:45) can shift an order into the "wrong" calendar day by this
  report's accounting. Revisiting this needs a restaurant-level timezone column and
  converting every report query's day-boundary math to use it, which is a real
  enough change to warrant its own slice rather than a quick patch here.
- **No export (CSV/PDF).** The report is view-only in the dashboard; there's no
  "download this range as a spreadsheet" button yet, which most competitors in this
  space do offer for handing numbers to an accountant.
- **No comparison to a prior period** ("vs. last week/month") — every KPI tile is
  an absolute number for the selected range with no delta indicator.
- **No branch-level breakdown**, same standing gap noted in every phase since 8a —
  a multi-branch restaurant's report is one combined number across all branches.
- **No loyalty/reservation-specific report sections** — Phase 8b's loyalty tiers and
  Phase 8d's reservation no-show rate aren't surfaced here yet, despite being
  natural additions flagged in the Phase 8d notes as a first idea for this phase;
  deferred in favor of shipping the core sales/expense/profit report first.

## Next steps

1. Move on to **Phase 10 (SaaS plans/trials/subscriptions/platform admin)** per the
   original roadmap.
2. Consider the "Known gaps" above — particularly a real COGS-based profit view
   layering Phase 7's recipe costing into this report, and a restaurant-level
   timezone column — as candidates for a future polish pass.
3. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
4. Push to GitHub from your machine.
