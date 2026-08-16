# Phase 11b — Offline POS

Phase 11a shipped multi-branch support, the first of Phase 11's four
sub-areas. This sub-phase (11b) tackles the second: keeping the staff-facing
POS usable through a network outage — a real concern for a momo cart or small
restaurant on a shared home broadband/mobile-data connection in Itahari,
where a dropped connection mid-shift shouldn't mean a waiter can't take
orders until it's back.

## Why this matters

A POS that hard-fails the moment the internet blips is worse than a paper
pad for a small restaurant with an unreliable connection. The goal here
isn't full offline-first architecture (that would mean offline menu editing,
offline inventory, conflict resolution across devices — well beyond what a
single-location shop needs) — it's specifically keeping the **order-taking
flow** unblocked: a waiter can keep adding items and submitting orders while
offline, each one gets saved on the device, and they all submit themselves
the moment the connection returns, with no staff action required and no risk
of an order silently getting lost or duplicated.

## What's done and verified

- **Schema**: `orders.client_request_id` (nullable `varchar(100)`) plus a
  **partial** unique index on `(restaurant_id, client_request_id)` —
  scoped to non-null values only, so the overwhelming majority of orders
  (QR customer orders, ordinary staff orders) that never set this column
  are completely unaffected. This is the server-side foundation everything
  else depends on: a client-generated UUID identifying one submission
  *attempt*, not the order itself, so retrying the same attempt — the whole
  point of an offline sync — can never create a duplicate order.
- **Idempotent order creation** (`POST /api/restaurants/[slug]/orders`):
  when a request includes `clientRequestId`, the route first checks for an
  existing order with that id and returns it unchanged (`200`, with
  `idempotentReplay: true` in the body) instead of doing the pricing/insert
  work again. If a genuinely concurrent retry races past that check, the
  unique-index collision on insert is caught and resolved the same way —
  fetch and return the row the other request just committed — rather than
  bubbling up as an error. A request with no `clientRequestId` behaves
  exactly as before Phase 11b (backward compatible by construction, not by
  a feature flag).
- **A real bug found and fixed while building this**: the existing
  order-number-collision retry loop (in both this route and the public
  `/api/order/[token]` route, since Phase 3/4) checked `err.code === "23505"`
  directly. drizzle-orm actually wraps a `db.transaction()` failure in a
  `DrizzleQueryError`, putting the real Postgres error code on
  `err.cause.code` — so that check had silently never worked; an actual
  order-number collision would rethrow instead of retrying. This almost
  certainly never manifested (order numbers use a random 4-hex suffix, so a
  real collision is rare), but it's now fixed everywhere via a shared
  `isUniqueViolation()` helper (`src/lib/db-error.ts`, unit tested for both
  the wrapped and unwrapped shapes) — and matters a lot more now, since the
  clientRequestId race-handling above depends on this check actually firing.
- **`src/lib/offline-queue.ts`** (browser-only) — an IndexedDB-backed queue
  of orders taken while offline. `enqueueOrder`/`listQueuedOrders`/
  `removeQueuedOrder` are the basic CRUD; `syncQueuedOrders(slug, submit)`
  walks the queue in creation order, calling the injected `submit` callback
  for each and removing it on success or marking it `error` (with the
  failure reason and an incrementing attempt count) on failure — one
  order's failure never blocks the rest of the queue from syncing. Fully
  unit tested (13 cases) against `fake-indexeddb`, a spec-faithful in-memory
  implementation, so the tests exercise the real async
  IDBRequest/transaction lifecycle rather than a hand-rolled mock.
- **`POSOrderBuilder.tsx`** now tracks `navigator.onLine` (plus `online`/
  `offline` window listeners) and wraps every order submission: online
  success behaves exactly as before (navigates to the new order's detail
  page); a network-level failure — offline, or a request that reaches
  neither the server nor back (`fetch` itself throwing, distinguished from
  an `ApiError` which means the server *did* respond) — enqueues the order
  locally instead of showing an error, resets the cart, and shows a "saved,
  will sync automatically" message. A "pending sync" panel lists queued
  orders with their status and a manual "Sync now" button; regaining
  connectivity (the `online` event) triggers an automatic sync attempt with
  no button press needed.
- **Offline menu caching**: every successful menu/table load is snapshotted
  to `localStorage`; if a load fails with a network-level error (not a
  server error), the POS page falls back to the last-known-good snapshot
  and shows a small "showing the menu from your last sync" notice, rather
  than a blank error screen.
- **`public/pos-sw.js`** — a minimal service worker, registered ONLY for
  `/dashboard/pos` (`scope: "/dashboard/pos/"`, never sitewide — a stale
  cached response on, say, a subscription-gated redirect elsewhere in the
  app would be a real bug, not a convenience). It's a plain
  network-falling-back-to-cache strategy for GET requests: every successful
  same-origin response gets cached, and a request that fails outright (no
  connectivity) is served from that cache instead. Deliberately NOT a
  precaching service worker — Next.js chunk filenames are content-hashed
  per build, so there's no fixed manifest to precache without the SW file
  itself needing regeneration on every deploy; runtime caching stays in
  sync with whatever's actually deployed for free. This is what keeps a
  full page reload of the POS page working while offline, layered on top
  of the localStorage menu snapshot and IndexedDB queue above (which work
  even without service worker support, e.g. in a browser where it's
  disabled).
- **Tests**: `src/lib/offline-queue.test.ts` (13 cases against
  fake-indexeddb), `src/lib/db-error.test.ts` (5 cases for the unique-
  violation helper, both wrapped and unwrapped shapes), and
  `src/db/__tests__/order-idempotency.test.ts` (3 DB-backed integration
  cases — the partial unique index rejects a same-restaurant duplicate,
  allows the same clientRequestId across two different restaurants, and
  allows unlimited null-clientRequestId orders). 319 tests total after this
  phase (up from 304), all passing.
- **Live smoke test** (`scripts/smoke-test-phase11b.sh`, 11 assertions, all
  passing) — the server-side idempotency contract over real HTTP: a plain
  order (no clientRequestId) still works unchanged; a fresh clientRequestId
  returns 201; retrying the identical request returns 200 with the SAME
  order id and `idempotentReplay: true`; a third retry is still idempotent;
  exactly one row exists in the database for that clientRequestId no matter
  how many times it was retried; and a genuinely different clientRequestId
  creates a genuinely separate order.
- **Playwright screenshots** (`scripts/screenshot-phase11b.mjs`, entity
  names prefixed `Phase11bTour`) — the POS page online, mid-add-to-cart
  while offline, the queued state (offline banner + "1 order waiting to
  sync" panel + confirmation message), and the synced state after
  `context.setOffline(false)` — with the script independently verifying via
  a direct API call that the offline-queued order actually landed
  server-side after auto-sync, not just that the UI looked right.

## Known gaps / deliberately deferred

- **Only order *creation* is offline-capable.** Status transitions, KDS
  actions, payments, and every other write in the app still require a live
  connection — this phase specifically targets the highest-value offline
  gap (a waiter unable to take a new order at all), not a general
  offline-first rewrite.
- **No cross-device conflict handling.** If two devices are both queuing
  orders offline against the same restaurant, they sync independently and
  never conflict with each other (different clientRequestIds), but there's
  no coordination between devices — this is fine for the common case
  (one POS device, or a few devices each taking genuinely separate orders)
  but wouldn't extend to, say, offline table-status coordination.
- **Retry-until-success is manual-or-online-triggered only** — there's no
  periodic background retry timer while the tab stays open and offline; a
  failed sync (e.g. the connection flaps back on then off again mid-sync)
  waits for the next `online` event or a manual "Sync now" click, not a
  timed retry loop. Simple by design: adding a timer risks hammering a
  flaky connection.
- **The service worker only caches GET requests for the POS page's own
  scope.** Other dashboard pages (Orders, KDS, etc.) have no offline
  support at all — this was a deliberate scope boundary, not an oversight;
  see "Why this matters" above.
- **No visible "last synced at" timestamp** or historical log of past syncs
  in the UI — once an order successfully syncs it's simply gone from the
  pending list, with no record kept of when.
- **`idempotentReplay` isn't surfaced anywhere in the UI** — it's in the API
  response for future use (e.g. an audit trail distinguishing "created" from
  "replayed") but the POS UI currently treats a 200 and a 201 identically.

## Next steps

1. Ask which of the two remaining Phase 11 sub-areas to build next —
   payment integrations or the AI assistant. Both are blocked on a decision
   only the user can make: payment integrations need real gateway
   credentials, and the AI assistant needs an LLM API/budget choice.
2. Consider extending the `isUniqueViolation`/idempotency pattern to other
   write endpoints if a similar "device may retry the same request" need
   comes up elsewhere (e.g. payments, once/if an offline payment-recording
   flow is ever requested).
3. Same standing item as every phase: run this against a real Supabase
   project once live credentials are available.
4. Push to GitHub from your machine.
