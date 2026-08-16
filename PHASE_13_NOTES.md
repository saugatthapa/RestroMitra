# Phase 13 — Discounts, service charge, and tips as first-class order/payment concepts

Scope selected from `PLATFORM_AUDIT.md`'s roadmap: **P0 #2 — discounts,
service charge, and tips flowing through pricing, receipts, and reports**,
the item explicitly flagged as "the single biggest POS gap for real-world
use." This phase deliberately did **not** touch `computeOrderPricing()`'s
existing per-line tax engine, the order state machine, the table/reservation
system from Phase 12, or the payment gateway integrations — those were
audited as already working and are only *called into* from the new code,
never rewritten.

## What was already implemented (reused, not rebuilt)

- The entire multi-tenant/RBAC architecture: `resolveRestaurantContext`,
  `requireBranchAccess`, `hasPermission`/`requirePermission`, the
  `role_permissions` DB table + `DEFAULT_ROLE_PERMISSIONS` seed pattern. No
  changes to the mechanism — only a new permission key (`APPLY_DISCOUNT`)
  added to the existing catalog, seeded the same way every other permission
  is.
- `computeOrderPricing()` (`src/lib/orders.ts`) — the per-line-item
  subtotal/tax engine. **Completely untouched.** Discount and service
  charge are layered on top of its output, never inside it.
- `computeBillingSummary()` (`src/lib/payments.ts`) — extended (not
  replaced) with a third parameter for tip amounts; every existing call
  site continues to work with the same two-argument signature (tips
  default to `[]`).
- The `.for("update")` row-lock + compare-and-swap pattern from the QA
  hardening pass — reused directly for the new adjustments route's order
  lock, rather than inventing a new concurrency strategy.
- `orders`, `payments` — no new tables. Discount/service-charge/tip fields
  were added as new *columns* on the existing tables (see migration below)
  — no duplicate orders, payments, or pricing systems.
- The bill-view, POS, and reports UIs — extended in place with new
  sections/fields; none of the existing rendering, payment recording, or
  refund flows were rewritten.

## What was built

### Backend

- **Migration `drizzle/0016_lethal_starfox.sql`**: one new enum
  (`discount_type`: percentage/flat) and six new columns on `orders`
  (`discount_type`, `discount_value`, `discount_in_paisa`,
  `discount_reason`, `service_charge_basis_points`,
  `service_charge_in_paisa`) plus one new column on `payments`
  (`tip_in_paisa`). Generated with `drizzle-kit generate`, run with
  `db:migrate` — no hand-written SQL, no changes to any other table.
- **`src/lib/order-adjustments.ts`** (new, pure/dependency-free, same
  pattern as `order-status.ts`) — `computeDiscountInPaisa()`,
  `computeServiceChargeInPaisa()`, and `computeOrderTotals()`, the single
  place `totalInPaisa` is derived once a discount/service charge exists.
  **Pricing policy (deliberate simplification, documented in-file)**:
  `totalInPaisa = subtotalInPaisa − discountInPaisa + serviceChargeInPaisa
  + taxInPaisa`. Both discount and service charge are computed against
  `subtotalInPaisa` only — never against tax, never against each other.
  Re-deriving tax to account for a discount would mean reworking the
  already-correct, tested per-line pricing engine, explicitly out of scope
  ("do not rewrite working systems"). **Known limitation**: a restaurant
  whose tax law requires VAT computed on the discounted/service-charge-
  inclusive amount would need a different formula — flagged here, not
  silently assumed correct for every jurisdiction.
- **`src/lib/validation/order-adjustments.ts`** (new) —
  `orderAdjustmentsInputSchema`, a discriminated Zod shape enforcing
  `discountPercent` XOR `discountFlatAmount` exactly when `discountType`
  matches, and `resolveOrderAdjustmentsInput()`, the one place
  human-friendly input (percent/rupees) converts to basis-points/paisa.
- **New permission `APPLY_DISCOUNT`** — owner/manager only (mirrors
  `REFUND_ORDER`'s trust tier), not bundled into the broader `EDIT_ORDER`,
  since discount/service-charge changes are financially sensitive in the
  same way refunds are.
- **New route** `PATCH /api/restaurants/[slug]/orders/[orderId]/adjustments`
  — sets an existing order's discount + service charge. **Whole-state, not
  a partial patch**: every call replaces the *complete* discount/service-
  charge configuration (an empty body clears everything) — matches how a
  settings form naturally submits its current full state, explicitly
  documented as differing from typical partial-PATCH semantics. Rejects
  (400) adjusting a cancelled order, and rejects (400) a new total that
  would fall below what's already been collected (directs staff to refund
  first rather than silently letting remaining-due go negative).
- **Wired into `orders/route.ts` POST** — an optional `adjustments` field,
  checked against `APPLY_DISCOUNT` via `hasPermission()` and rejected (403)
  for a caller without it, rather than silently ignored (which would be
  confusing). The QR public route (`order/[token]/route.ts`) needed no
  changes — new-column defaults already produce the correct
  `totalInPaisa` for orders with no adjustments.
- **Tips wired into `payments/route.ts` POST** — a per-payment
  `tipInPaisa` field, deliberately excluded from the remaining-due/
  overpayment check (pure additive bookkeeping, not part of the bill).
  Surfaced in `computeBillingSummary`'s new `tipTotalInPaisa` field and in
  the order-detail GET response.
- **`src/lib/reports.ts`** — `getSalesSummary` gained
  `discountInPaisa`/`serviceChargeInPaisa` (summed from *completed* orders,
  same scoping as revenue — informational only, since `revenueInPaisa` is
  already net-of-discount/inclusive-of-service-charge). New
  `getTipsSummary()`, scoped by `payments.createdAt` (when the tip was
  recorded), same convention as `getPaymentMethodBreakdown` — **not**
  order-status scoped, so tips on a still-pending order still count.
- **Security fix found and fixed while wiring tips into
  `payments/route.ts`**: that route and `refunds/route.ts` were both
  missing the `requireBranchAccess()` branch-scoping check that the QA
  hardening pass added only to the order-status route — a branch-scoped
  waiter/cashier could record a payment or refund against an order
  belonging to a *different* branch of the same restaurant.
  `QA_HARDENING_NOTES.md`'s own text implied "the rest of the app enforces"
  this, but a grep confirmed neither route actually had it. Fixed by
  adding the identical `requireBranchAccess(...)` call (same pattern, same
  reasoning) to both routes, plus the new adjustments route. **Verified
  live**: a branch-scoped manager gets 403 attempting a payment, refund, or
  adjustment against another branch's order (`scripts/smoke-test-
  phase13.sh`, Part 6).

### Frontend

- **`POSOrderBuilder.tsx`** (modified) — a discount/service-charge section
  (gated on a new `canApplyDiscount` prop), with a live client-side preview
  via `computeOrderTotals()` (the same pure function the backend uses).
  The preview is explicitly labeled "Excludes tax — the final total... is
  calculated at checkout," since per-item tax rates aren't known
  client-side. `pos/page.tsx` computes `canApplyDiscount` from the active
  role and passes it down.
- **`OrderBillView.tsx`** (modified) — the bill breakdown now shows
  discount (with reason), service charge, and a "Tips (not part of the
  bill)" line; payment history shows each payment's tip inline. A new
  **`AdjustmentsPanel`** component (gated on `canApplyDiscount`, hidden for
  a cancelled order) calls the PATCH `.../adjustments` route, seeded from
  the order's current values so opening it shows what's already applied.
  `RecordPaymentForm` gained a tip input field. `orders/[orderId]/page.tsx`
  computes and passes `canApplyDiscount`.
- **`ReportsBoard.tsx`** (modified) — three new stat tiles: "Discounts
  given," "Service charge collected," "Tips collected."

## Testing performed

- Full existing regression suite re-run and green after this phase's
  changes: `npx vitest run` (**412 tests passing**, up from 372 — 40 new;
  0 failures), `npx tsc --noEmit`, `npx eslint .`, `npx next build`
  (production build succeeds, `.../orders/[orderId]/adjustments` listed
  among the generated routes), and **all 20 existing
  `smoke-test-phase*.sh` scripts** (3, 4, 5, 6, 7, 8, 8b, 8c, 8d, 9, 10,
  11a, 11b, 11c, 11d, 12) re-run unmodified — all pass, confirming no
  regression from this phase's schema/route changes (including the
  branch-scoping fix, which only *adds* a check and doesn't change
  behavior for unrestricted roles).
- **New**: `src/lib/order-adjustments.test.ts` — 25 unit tests for
  `computeDiscountInPaisa`/`computeServiceChargeInPaisa`/
  `computeOrderTotals`: percentage/flat math, rounding, clamping (100%+
  discount, flat discount exceeding subtotal), zero-subtotal edge cases,
  discount+service-charge combined.
- **New**: `src/lib/validation/order-adjustments.test.ts` — 15 unit tests
  for the discriminated Zod shape (valid/invalid combinations of
  discountType × discountPercent/discountFlatAmount) and
  `resolveOrderAdjustmentsInput`'s percent→basis-points/rupees→paisa
  conversion and reason trimming.
- **New**: `src/lib/payments.test.ts` extended — `computeTipTotal` tests
  and a `computeBillingSummary` test asserting tips are summed
  independently of the payment/remaining-due math.
- **New**: `src/lib/ai/assistant.test.ts` fixtures updated for the
  `ReportSummary` type's new fields (this was a type-only fix caught by
  `tsc`, not a behavior change to the AI assistant).
- **New**: `scripts/smoke-test-phase13.sh` — **22 live HTTP/DB
  assertions**: `APPLY_DISCOUNT` permission gating at order-creation time
  (waiter 403, manager/owner 200) and on the adjustments PATCH route,
  percentage/flat/combined discount+service-charge computation against a
  real order, malformed-shape rejection (400), the adjustments route's
  whole-state semantics (an empty PATCH clears an existing discount),
  rejecting adjustments on a cancelled order (400) and on a would-go-
  negative total (400, must refund first), tip recording not affecting
  remaining-due while appearing in `billing.tipTotalInPaisa` and the order
  detail GET, reports surfacing discount/service-charge/tip totals, and —
  the security fix — a branch-scoped manager getting 403 on a payment,
  refund, and adjustment against a different branch's order.
- **New**: `scripts/screenshot-phase13.mjs` — live Playwright screenshots
  (reviewed): the POS discount panel with a live preview breakdown
  (subtotal/discount/service charge/estimated total), the order bill view
  with discount/service-charge/tax/tips all correctly displayed, and the
  adjustments panel pre-populated with an order's existing discount/reason
  when reopened. A companion ad hoc reports screenshot also confirmed the
  three new stat tiles render (and correctly show Rs 0 for discount/
  service-charge on a still-pending order — those are scoped to
  *completed* orders by design — while tips, which are payment-time
  scoped, show the recorded amount).

### One production bug caught by `tsc`, not by hand

Extending `ReportSummary`'s shape broke two fixture objects in
`assistant.test.ts` that were relying on structural typing without the new
fields — caught by `npx tsc --noEmit` before any test run, fixed by adding
the new fields to both fixtures. No behavior changed in `assistant.ts`
itself.

## Remaining gaps

- **Tax is never re-derived against a discounted/service-charge-inclusive
  amount** — the deliberate pricing-policy simplification described above.
  Correct for the common "service charge before tax, discount on the food
  bill" convention, but a restaurant whose tax authority requires VAT on
  the post-discount/post-service-charge amount would need a different
  formula. Flagged, not silently assumed universal.
- **No restaurant-wide default service charge** — every order's service
  charge is set per-order (at creation or via the adjustments route); a
  restaurant that always charges 10% has to enter it every time, or a
  manager has to add it via the adjustments panel after the fact. A
  "default service charge %" setting is a natural follow-up, deliberately
  not built this phase — there's no restaurant-settings-editing
  infrastructure to hang it on yet.
- **No tip-splitting or per-staff-member tip attribution** — tips are
  recorded per-payment (who paid), not per-server (who gets it). Tracking
  which staff member a tip belongs to would need a new field on
  `payments` (`servedByUserId` or similar) and reporting keyed by staff —
  out of scope for "tips as first-class order/payment concepts," which
  this phase satisfies at the bookkeeping level.
- **The POS live preview excludes tax** — by design (per-item tax rates
  aren't known client-side without an extra fetch), but it does mean a
  staff member sees "Estimated total" pre-tax during order entry and only
  the true tax-inclusive total after the order is placed. Labeled clearly
  in the UI rather than presented as final.
