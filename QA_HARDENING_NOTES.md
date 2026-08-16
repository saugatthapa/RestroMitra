# QA hardening pass — pre-launch bug audit + tablet/phone responsive fixes

The user's explicit scope for this pass, verbatim: "a harder bug/QA pass
before real customers and real money touch it" and "making sure the POS/KDS
screens actually work well on the tablets/phones staff would use at the
counter." This is not a new feature phase — it's a deliberate stop-and-check
before the app is trusted with real orders and real payments, covering two
distinct halves: (A) a security/correctness audit of the money- and
auth-critical code paths, and (B) a responsive-design pass on the two
screens staff actually touch at the counter or in the kitchen.

## Part A — bug/security audit

Three independent read-only audits were run in parallel over the codebase:
money/payments (payment gateways, refunds, the payments ledger), auth/RBAC
(every permission check, every `restaurant_id`/`branch_id` trust boundary),
and order/inventory/offline-sync (the order state machine, stock deduction,
the offline POS queue). The auth/RBAC audit found no exploitable bugs —
tenant isolation and permission checks are consistently and correctly
applied everywhere they were checked. The other two surfaced five real bugs,
all fixed and verified live against the running server (not just unit
tests) with genuine concurrent requests, since races are exactly the kind of
bug a single-request test can't see.

### 1. eSewa production mode could silently forge payments (CRITICAL)

`getEsewaConfig()` fell back to eSewa's own *public* sandbox product
code/secret key (`EPAYTEST` / a key published in eSewa's own docs) whenever
`ESEWA_PRODUCT_CODE`/`ESEWA_SECRET_KEY` were unset — including in
`ESEWA_ENV=production`. Since eSewa signs its callback with an HMAC of that
secret key, and the sandbox key is public knowledge, anyone could compute a
validly-signed "payment complete" callback for a live order without eSewa
ever being involved — a free path to marking any order paid. `getKhaltiConfig()`
already threw when its key was missing; `getEsewaConfig()` didn't, purely
because it has a legitimate sandbox fallback that Khalti doesn't. Fixed:
`getEsewaConfig()` now throws an actionable error when
`ESEWA_ENV=production` and either credential is still unset, with the same
"fail toward the safe/no-money side" philosophy the rest of the payment
config already followed. Covered by 4 new cases in
`src/lib/payment-gateways/config.test.ts` (this file didn't exist before —
`getEsewaConfig`/`getKhaltiConfig` had no direct unit tests until now).

### 2. Gateway callback could double-credit a payment (CRITICAL)

`GET /api/payments/gateway/[gateway]/callback` is the public, unauthenticated
landing page eSewa/Khalti redirect the browser to after a payment. It read
the transaction row, checked `status === "completed"` as a fast idempotency
path, then verified with the gateway and inserted a `payments` row — all
without any lock. Two overlapping hits on the exact same callback URL (a
double-tap on a slow mobile connection, a browser "retry," the gateway
itself re-delivering the redirect) could both read `"initiated"` before
either committed, both pass verification, and both insert a payment row for
the same real-world transaction — silently double-crediting the order.
Fixed with `SELECT ... FOR UPDATE` on the transaction row inside the
completion transaction, re-checking `status` after acquiring the lock; the
losing request now returns the already-recorded payment instead of
inserting a second one. **Verified live**: two genuinely concurrent
`fetch()` calls at the same callback URL both redirect as "success" from the
caller's point of view, but exactly one `payments` row is created.

### 3. Manual payments and refunds could both overshoot the order total (HIGH)

Both `POST /orders/[orderId]/payments` and `POST /orders/[orderId]/refunds`
read the order and its existing payments, checked the request against that
snapshot (reject an overpayment / reject a refund larger than net-paid), then
inserted — with no row lock across the read-check-write. Two concurrent
requests could both read the same stale totals, both pass the same check,
and jointly overpay or over-refund an order. Fixed by adding `.for("update")`
to the initial order `SELECT` in both routes, serializing concurrent
requests on the same order. **Verified live**: two concurrent payment
requests (and separately, two concurrent refund requests) against the same
order — exactly one succeeds, the other is rejected with a 400, and the
ledger never goes negative or above the order total.

### 4. Order status changes had a TOCTOU race that could double-fire side effects (CRITICAL)

`PATCH /orders/[orderId]/status` read the order's current status in a plain
`SELECT`, then later ran an `UPDATE` whose `WHERE` clause never re-checked
that status. Two concurrent PATCH requests reading the same stale status
(e.g. both requesting `confirmed → preparing`, or one requesting an advance
while another requests a cancel) could both pass permission/transition
checks and both commit — double-deducting recipe stock, double-awarding
loyalty points, or silently overwriting a concurrent cancellation depending
on whichever `UPDATE` committed last. Fixed via optimistic concurrency: the
`UPDATE`'s `WHERE` clause now includes `status = currentStatus`
(compare-and-swap) — Postgres re-evaluates that predicate against the
latest committed row, so the losing request's `UPDATE` matches zero rows and
the route returns a 409 instead of running its side effects twice.
**Verified live**: two concurrent status-advance requests on the same
order — exactly one returns 200, the other 409 — and a tracked ingredient's
stock is deducted exactly once (100 milliunits from a deliberately small,
exact 0.1g/serving recipe), not twice.

### 5. Order status route was missing branch scoping (HIGH)

Every other order-mutating route (creation, payments, refunds) resolves and
enforces the caller's branch grant via `requireBranchAccess()`; the status
route never did. A branch-scoped waiter or kitchen_staff account — someone
explicitly granted access to only one branch of a multi-branch restaurant —
could advance or cancel an order belonging to a *different* branch of the
same restaurant, bypassing the branch boundary the rest of the app enforces.
Fixed by adding the same `requireBranchAccess()` call this route was
missing, right after the order is fetched (using the order's own
`branchId`). Unrestricted grants (owner/manager/platform_admin, whose
`branchId` is `null`) are unaffected. **Verified live**: a waiter scoped to
branch B gets a 403 attempting to change the status of an order that
belongs to the restaurant's main branch.

### 6. No way to discard a permanently-failing offline order (lower severity, UX)

The offline POS queue (`src/lib/offline-queue.ts`) already tracked a
per-order `status: "error"` for orders that fail to sync (e.g. a menu item
referenced in the order was deleted while the device was offline — every
retry gets the same permanent 400, not a transient network error), but the
POS screen gave staff no way to clear one short of clearing browser storage.
`removeQueuedOrder()` already existed and was already exported but was
never called from the UI. Fixed by adding a "Discard" button next to any
queued order in the `error` state — it's a deliberately confirmed,
destructive, staff-initiated action (the order's details are genuinely lost,
not just its queued status), and it's only ever offered once a sync attempt
has actually failed, never on a plain "waiting for signal" order.

### A design decision that was deliberately NOT changed

The gateway callback route does **not** reject a payment just because the
order already looks fully paid (unlike the manual-payment route, which does
reject overpayments outright). By the time this callback runs, the gateway
has already collected real money in the physical world — silently
discarding that record because a cashier separately recorded a cash payment
while the gateway session was still pending would be worse than recording it
with a `possibleOverpayment` flag on the payment note for staff to review
and potentially refund. This is intentional, not an oversight.

## Part B — POS/KDS tablet & phone responsive pass

Screenshotted `/dashboard/pos` and `/dashboard/kds` with Playwright at four
breakpoints representative of real staff hardware: tablet landscape
(1024×768), tablet portrait (768×1024), and two phone sizes (414×896,
390×844) — plus the POS "customize item" modal, since bottom-sheet-style
modals are a common mobile trouble spot. Two real, concrete bugs surfaced.

### 1. No way to navigate on any screen narrower than 768px (CRITICAL)

`DashboardShell`'s entire sidebar navigation was `hidden md:block` with
**no fallback of any kind** — no hamburger button, no bottom nav, nothing.
Below the 768px breakpoint (every phone, and any tablet held in portrait
narrower than 768px), a staff member had no way to reach any other page —
Orders, Menu, Inventory, even POS or KDS themselves — short of typing a URL
by hand. This wasn't a POS/KDS-specific bug, it affected the whole
dashboard, but it's exactly the kind of thing that would make the app
unusable on the actual hardware (phones, most tablets in portrait) staff
would carry around a counter or kitchen. Fixed by adding a slide-in mobile
nav drawer (`src/app/dashboard/DashboardShell.tsx`): a hamburger button in
the header that only renders below `md`, opening a full-height overlay
drawer that reuses the exact same nav list as the desktop sidebar, closable
via a backdrop tap, an explicit close button, or automatically when a nav
link is clicked. **Verified live** with Playwright at 390px width: the
desktop sidebar is confirmed not visible, the hamburger opens the drawer,
and clicking a nav link both navigates to the target page and closes the
drawer.

### 2. KDS ticket board went 3-column too early, cramping tablet-portrait tickets (MEDIUM)

`KDSBoard`'s three-column layout (`Waiting to start` / `In progress` /
`Ready`) switched from a single column to three at Tailwind's `sm` (640px)
breakpoint. Combined with the sidebar's fixed 240px width (visible from
`md`, 768px), a tablet held in portrait at exactly 768px had only ~170px per
column — narrow enough that ticket IDs and column headers wrapped mid-word,
exactly the glance-and-go readability a kitchen counter can't afford under
real order volume. Fixed by moving to `grid-cols-1 sm:grid-cols-2
lg:grid-cols-3` — two columns from `sm` (enough room on a phone turned
landscape), three only once there's genuinely enough width (`lg`, 1024px,
where the screenshot showed no wrapping at all). Verified via a re-screenshot
at 768×1024: all three column headers and every ticket ID/item line render
on one line with no wrapping.

### What was checked and found fine

The POS item grid and cart sidebar (`flex flex-col gap-4 lg:flex-row`)
already stacked correctly below `lg` and never overflowed at any tested
width; the item-customize modal already used a bottom-sheet pattern below
`sm` and a centered modal above it, and stayed fully within the viewport at
every breakpoint tested, including with two variants and an add-on visible.
Neither needed a change.

## Testing

- **`scripts/qa-hardening-verify.mjs`** (new) — a Node.js script making
  genuine concurrent `fetch()` calls against the live running dev server
  (not Vitest — the routes under test sit behind `requireAuth()`, which
  needs `next/headers`'s `cookies()`, which only works inside a real
  request handled by the actual Next server; a directly-invoked route
  handler in a test file has no request-scoped context for it to read). 13
  assertions across all five audit fixes, all passing.
- **`scripts/screenshot-responsive-pos-kds.mjs`** (new) — seeds a
  restaurant with a menu (including a variant+add-on item to exercise the
  customize modal), tables, and three live orders spread across the KDS's
  three columns, then screenshots POS, the customize modal, and KDS at all
  four breakpoints — 12 screenshots in `screenshots-responsive/`.
- 7 new unit tests in `src/lib/payment-gateways/config.test.ts` (didn't
  exist before this pass) covering both eSewa's new production-mode throw
  and Khalti's existing one.
- Full regression pass after every fix: `npx vitest run` (351 tests, 46
  files, all passing), `npx tsc --noEmit` (clean), `npx eslint .` (clean),
  `npx next build` (clean production build, all 28 routes), and all 15
  existing phase smoke-test shell scripts (`scripts/smoke-test-phase*.sh`,
  covering Phases 3 through 11d) — all still passing after every schema/
  route change in this pass.

## Known gaps / deliberately out of scope for this pass

- The five audit-found bugs were fixed with targeted, verified changes, but
  no exhaustive fuzz/penetration test was run — this was a focused pass on
  the three areas the audits covered (money/payments, auth/RBAC, order/
  inventory/offline-sync), not a full external security review. Before
  handling real customer payment data at scale, a professional security
  review is still worth commissioning.
- The responsive pass covered POS and KDS specifically, per the user's
  scope — the mobile-nav-drawer fix benefits every dashboard page (since it
  lives in the shared `DashboardShell`), but no other individual page
  (Menu, Inventory, Reports, etc.) was screenshotted or audited for its own
  internal responsive layout at these breakpoints.
- No automated regression test exists yet for the mobile nav drawer or the
  KDS column breakpoints specifically (verified via one-off Playwright
  scripts during this pass, not added as a permanent Vitest/Playwright
  suite) — worth adding if the dashboard shell changes again.
- The offline-queue "Discard" button (Part A, #6) is UI-only and wasn't
  covered by the live concurrency script, since it doesn't involve a race —
  only manually verified by reading the code path.

## Next steps

1. Set real production credentials (`ESEWA_PRODUCT_CODE`/`ESEWA_SECRET_KEY`,
   `KHALTI_SECRET_KEY`, `ANTHROPIC_API_KEY`) before flipping `*_ENV` to
   `production` anywhere — the eSewa fix in this pass means that flag will
   now correctly refuse to start without them, rather than silently running
   insecurely.
2. Consider a permanent automated test (Vitest + Testing Library, or a
   Playwright test) for the mobile nav drawer and KDS breakpoints so a
   future change to `DashboardShell` or `KDSBoard` can't silently
   regress this pass's fixes.
3. Same standing item as every phase: run this against a real Supabase
   project once live credentials are available, and push to GitHub from
   your machine.
4. Push to GitHub from your machine.
