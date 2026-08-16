# Phase 11c — Payment gateway integrations (eSewa + Khalti)

Phases 11a and 11b shipped multi-branch support and offline POS order-taking,
the first two of Phase 11's four sub-areas. This sub-phase (11c) tackles the
third: letting a customer pay a bill through a real Nepali digital wallet
instead of only cash/card/manual "mobile wallet" entry — the actual eSewa/
Khalti redirect flow, not just a payment method label.

## Scope decision

The user was asked which gateway(s) to build and picked a combination that
included eSewa, Khalti, "cash/manual only for now" (originally meant as a
mutually-exclusive "skip this" option), and a typed-in "Bank/ConnectIPS/
credit, debit card" option. Given the contradiction, the interpretation
taken (stated to the user before starting) was: build eSewa and Khalti —
both are simple, self-serve, sandbox-testable digital wallet gateways with
public developer programs — and explicitly set aside ConnectIPS/card
processing, since that requires an actual bank merchant relationship (a
business bank account + a signed agreement), not just a self-serve API key.
That's a real-world prerequisite this build environment can't stand in for,
so it's flagged here as a clear, actionable next step once the user has that
relationship in place, rather than attempted with fake placeholders.

The user separately chose to build against each gateway's **public sandbox**
first, rather than provide live merchant credentials — appropriate, since
neither gateway can be safely tested with real money from an automated build
process.

## What's done and verified

- **Schema**: a new `payment_gateway_transactions` table — deliberately a
  separate table from `payments`, not a new column on it. It's the
  pending/in-flight ledger for the redirect round-trip only (`initiated` →
  `completed`/`failed`/`cancelled`); a successful gateway payment always
  culminates in an ordinary `payments` row (`method: "mobile_wallet"`, an
  enum value that already existed before this phase, labeled "Mobile wallet
  (eSewa/Khalti)" since Phase 5). This means refunds, billing summaries, and
  reports need **zero** gateway-specific logic — they already handle
  `mobile_wallet` payments identically to cash/card. `gatewayReference` (our
  own `crypto.randomUUID()`, generated at initiate time, never anything
  supplied by the client or read back from a gateway) has a unique index
  scoped per restaurant — the same idempotency-anchor pattern
  `clientRequestId` established in Phase 11b, reused here as the sole trust
  anchor the public callback route uses to identify a transaction.
- **`src/lib/payment-gateways/config.ts`** — `getEsewaConfig()` defaults to
  eSewa's own publicly documented UAT test credentials (product code
  `EPAYTEST`) when no env vars are set, so eSewa payments work out of the box
  against eSewa's real sandbox with zero setup. `getKhaltiConfig()` throws
  immediately with an actionable error message if `KHALTI_SECRET_KEY` isn't
  set — Khalti has no shared/public sandbox key the way eSewa does; every
  merchant (even in test mode) gets their own key from a free signup at
  `test-admin.khalti.com`. Both default to `test` env unless `*_ENV` is
  explicitly set to `production`, so a missing/misconfigured env var fails
  toward the safe (sandbox, no real money) side.
- **`src/lib/payment-gateways/esewa.ts`** — `buildEsewaFormFields()` builds
  the signed form-POST fields eSewa's hosted payment page expects (amount
  converted from our internal paisa to eSewa's decimal-rupee string,
  HMAC-SHA256 signature over the fixed `total_amount,transaction_uuid,
  product_code` field set). `verifyEsewaCallback()` decodes the base64
  `data` query param eSewa redirects back with and recomputes the same
  signature — only ever over the fixed known field set, refusing anything
  that claims a different one — to confirm the payload genuinely came from
  someone holding our shared secret, not a client-forged query string. Both
  are pure local computation (HMAC-SHA256, no network at all), so they're
  fully live-tested here — see below. `checkEsewaStatus()` (the optional
  server-to-server confirmation call) takes an injectable `fetchImpl` but is
  not currently called by any route — it's available for a future
  defense-in-depth pass, not required for the redirect-callback flow to work
  correctly, and would need live network to exercise (see gaps below).
- **`src/lib/payment-gateways/khalti.ts`** — `initiateKhaltiPayment()` and
  `lookupKhaltiPayment()`, both REST calls with an injectable `fetchImpl`.
  Khalti amounts are paisa already (no unit conversion, unlike eSewa).
  `lookupKhaltiPayment()` is always called with the `pidx` **we stored** from
  the initiate response, never the `pidx` arriving in the callback's own
  query string — closing off a theoretical pidx-substitution attack where
  someone hits our callback URL with a different (valid, unrelated) pidx
  they noticed elsewhere.
- **`POST /api/restaurants/[slug]/orders/[orderId]/payments/gateway/
  [gateway]/initiate`** (authenticated, `EDIT_ORDER`) — validates the order
  exists, isn't cancelled, and has a remaining due balance; generates a
  fresh `gatewayReference`; inserts an `initiated` transaction row *before*
  contacting either gateway; then either returns signed eSewa form fields
  (for the client to auto-submit as a hidden form POST) or calls Khalti's
  initiate API and returns its `payment_url` to redirect to. A Khalti
  initiate failure (including a missing `KHALTI_SECRET_KEY`) is caught,
  marks the transaction row `failed`, and returns a `502` rather than
  crashing.
- **`GET /api/payments/gateway/[gateway]/callback`** (PUBLIC, top-level, no
  session) — the browser's landing pad after either gateway redirects back.
  Resolves the transaction **exclusively** via `gatewayReference` — never
  trusting an amount/order id/status read directly from the query string for
  either gateway. Idempotent by construction: replaying the exact same URL
  (e.g. the user hitting refresh) redirects straight through on an
  already-`completed` row without reprocessing or double-charging — checked
  and tested explicitly. On a verified success, records a `payments` row
  inside the same code path `POST .../payments` uses (`computeBillingSummary`
  → update `orders.paymentStatus`), links it back onto the transaction row,
  and writes an audit log entry (`payment.gateway_completed`). Always
  finishes by redirecting the browser to
  `/dashboard/orders/[orderId]?payment=success` or `?payment=failed` — this
  route renders no HTML of its own.
- **`OrderBillView.tsx`** — a new "Pay with a wallet" panel (visible when
  `canEdit && remainingDueInPaisa > 0`, same gate as the manual "Record a
  payment" form) with "Pay via eSewa"/"Pay via Khalti" buttons. eSewa's
  response is auto-submitted as a hidden HTML form (eSewa's flow is a
  browser form POST, not a plain redirect); Khalti's is a plain
  `window.location.href` redirect to its returned `payment_url`. On return,
  the page reads `?payment=success|failed` from the URL and shows a
  confirmation/failure banner above the bill.
- **Tests**: `esewa.test.ts` (12 cases — signature generation, a full valid
  round trip, and three separate tamper/forgery rejection cases: amount
  changed after signing, wrong secret key, and a payload claiming to sign
  fields outside the known set) — all genuinely exercised locally, no
  network needed. `khalti.test.ts` (mocked-`fetchImpl` — request shape,
  auth header, paisa-not-converted amounts, and error handling for both a
  non-ok HTTP status and a malformed response body). A real DB-backed
  integration test, `callback/route.test.ts` (3 cases), calls the **actual
  exported route handler** (not a reimplementation) against a live database:
  a fully valid signed eSewa callback records a payment and marks the
  transaction completed; a replayed identical callback does not create a
  second payment; a tampered signature is rejected and marks the
  transaction failed; an unknown `gatewayReference` redirects gracefully
  instead of erroring. 334 tests total after this phase (up from 319), all
  passing.
- **Live smoke test** (`scripts/smoke-test-phase11c.sh`, 16 assertions, all
  passing) — the full eSewa round trip over real HTTP against the running
  dev server and local Postgres: initiate returns the correct sandbox form
  URL and a rupee-converted total; a callback signed exactly the way eSewa
  itself would (built with plain `node -e` HMAC, matching the app's own
  algorithm) is accepted, records the payment, and updates the order's
  `paymentStatus` to `paid`; replaying the same callback URL doesn't
  double-charge; initiating on an already-fully-paid order is rejected
  (400); an unknown `[gateway]` route param is rejected (400); a garbage/
  unknown `gatewayReference` at the callback still redirects gracefully
  (not a 500); and Khalti's initiate route is confirmed to fail *gracefully*
  (502, not a crash) given this sandbox's blocked network / missing test key
  — see "Known limitation" below.
- **Playwright screenshots** (`scripts/screenshot-phase11c.mjs`) — the
  unpaid bill view showing the "Pay via eSewa"/"Pay via Khalti" buttons
  alongside the existing manual payment form, and the bill view after
  landing back from a (locally simulated, signature-verified) successful
  eSewa payment: the green "Payment received" banner, `Paid` status badge,
  Rs. 0.00 remaining due, and a "Mobile wallet (eSewa/Khalti)" line in the
  payment history noting "Paid via eSewa" — independently confirmed
  server-side via a direct API call that `paymentStatus` is `paid` and the
  payment's `method` is `mobile_wallet`, not just that the UI looked right.

## Known limitation — Khalti could not be live-verified from this build environment

This is a real, disclosed gap, not a "known gap by design" scope decision
like the ones below. **Outbound network access from this sandbox to
`esewa.com.np`/`khalti.com` domains is blocked** (confirmed via repeated
curl timeouts, exit code 56, to `rc.esewa.com.np`, `rc-epay.esewa.com.np`,
and `dev.khalti.com` during development). This has different consequences
for each gateway:

- **eSewa**: the callback-verification half (HMAC signature check) needs no
  network at all, so it's fully live-tested — both in `esewa.test.ts` and in
  the real HTTP smoke test above. Only the *optional* server-to-server
  status-check call (`checkEsewaStatus()`) would need live network, and it
  isn't used by any route yet (a possible future defense-in-depth addition).
- **Khalti**: its ENTIRE flow — both `initiate` and `lookup` — is a REST API
  call to Khalti's servers. Neither could be exercised against Khalti's real
  sandbox from within this build environment, and there is no publicly
  shared Khalti test key to even attempt it with (unlike eSewa). The request
  building, auth header, response parsing, and error handling for both
  calls ARE tested — via `khalti.test.ts`'s mocked `fetchImpl` — but that
  only proves the code does the right thing *given* a certain network
  response, not that Khalti's real API actually behaves the way the docs
  say it does.

**Before relying on Khalti in production**: sign up at
`test-admin.khalti.com` for a free test secret key, set `KHALTI_SECRET_KEY`
in an environment with real network access to `dev.khalti.com`, and run
through a full initiate → hosted-page payment → callback → lookup cycle by
hand at least once. The code is believed correct against Khalti's published
API docs, but "believed correct against docs" and "verified against the
real API" are different claims, and only the first one can be made from
here.

## Known gaps / deliberately deferred

- **ConnectIPS / card processing is out of scope.** Unlike eSewa/Khalti,
  ConnectIPS requires an actual bank merchant relationship (a business bank
  account + signed agreement with a participating bank), not a self-serve
  API signup — there's no sandbox a build process can integrate against on
  its own. Revisit once the user has that relationship in place; the
  `payment_gateway_transactions` table/enum and the initiate/callback route
  shape were designed generically enough that adding a third gateway should
  mostly mean a new `payment-gateways/connectips.ts` module and a new enum
  value, not a schema rework.
- **A gateway payment always charges the full remaining due amount** — there
  is no partial-gateway-payment flow (split a bill between, say, half cash
  and half eSewa isn't directly supported through the gateway buttons,
  though nothing stops staff from recording a manual partial cash payment
  first and then using the gateway buttons for the remainder, since they
  recompute against whatever's left due at initiate time).
- **No customer-facing/public payment link.** Both gateway buttons live in
  the staff dashboard's order bill view (`canEdit`-gated) — there's no
  shareable link a customer could open on their own phone to pay their own
  bill without staff present. That would be a reasonable follow-up (a public
  variant of the initiate route, keyed on something other than a staff
  session — e.g. a per-order token) but wasn't requested and adds its own
  abuse-prevention surface (rate limiting an unauthenticated payment-
  initiation endpoint) that felt out of scope for this pass.
- **No gateway-specific refund flow.** A gateway-paid order refunds through
  the exact same manual refund form as any other payment method (money
  handed back in cash/bank transfer, recorded against the original
  `mobile_wallet` payment) — there's no "refund via eSewa/Khalti API" button
  that would push money back through the original gateway. Both gateways do
  expose refund APIs, but wiring that up needs a live merchant dashboard to
  test against safely, which is a natural next step once real credentials
  exist.
- **`checkEsewaStatus()` is unused.** It exists and is unit-testable (via
  its own injectable `fetchImpl`), but no route currently calls it — the
  redirect-callback verification (signature check) is treated as sufficient
  on its own. Wiring it in as an extra defense-in-depth confirmation is a
  reasonable low-risk follow-up once live network access to eSewa is
  available to actually exercise it end to end.

## Next steps

1. The AI assistant remains the last unstarted Phase 11 sub-area — blocked
   on the user supplying an LLM API/budget decision.
2. Sign up for a free Khalti test key and manually verify the live sandbox
   round trip once this runs somewhere with unblocked network access (see
   "Known limitation" above) — this is the single highest-value follow-up
   specific to this phase.
3. Same standing item as every phase: run this against a real Supabase
   project once live credentials (for the app's own DB, and eventually real
   eSewa/Khalti merchant credentials) are available.
4. Push to GitHub from your machine.
