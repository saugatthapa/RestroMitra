# RestroMitra — Final Release-Candidate Audit

Fresh audit against the CURRENT codebase (not the prior audit docs, not commit messages). Ten parallel investigations, each read-only, each required to cite file:line and — where practical — actually run the relevant tests/queries rather than assume. This document is the synthesis; findings below were re-verified by me before being marked "Already fixed."

**Update (Phase B/C complete):** every finding below marked "Fixed this pass" has now actually been implemented, tested (regression test + full suite + tsc + lint + build, every time), and committed — not just described as a plan. See `RELEASE_READINESS.md` for the final scorecard and score, and the bordered summary delivered alongside this pass for the exact commit-by-commit breakdown. The baseline block below is left as originally captured (start-of-pass state); final numbers are in `RELEASE_READINESS.md`.

```text
Current commit:   3601424d5c7b7514020894c45102860762ac34e (HEAD, main) — BASELINE, start of this pass
Current branch:   main
Working tree:     clean at audit start (P2_PROGRESS_CHECKPOINT.md untracked, doc-only)
Node version:     v22.22.2
Next.js version:  15.5.23 (confirmed: newest available 15.x — the `backport` dist-tag points at 15.5.23 itself)
Database:         Postgres 16, Drizzle ORM, 33 migrations (0000–0032), verified clean on both a genuinely fresh DB and the populated dev DB
Test count:       648 passing (81 files)
E2E count:        5 passing (4 specs)
Build status:     clean (npm run build, exit 0)
Lint status:      clean (0 errors, 6 pre-existing warnings, none in this pass's files)
TypeScript status: clean (npx tsc --noEmit, exit 0)
CI status:        .github/workflows/ci.yml — correct step order (ci→lint→typecheck→migrate→seed→test→build→E2E), real Postgres service container, no continue-on-error, no hardcoded secrets
```

## How to read this document

Every finding is classified:

- **P0** — must fix before any real restaurant uses the system
- **P1** — should fix before broad commercial launch
- **P2** — useful enhancement, does not block launch
- **Already fixed (verified)** — read the current code and confirmed correct; cited
- **Does not exist** — a feature the spec asked about that was never built; stated plainly, not treated as a "bug"

Nothing here was accepted on a subagent's word alone — every P0/P1 finding below was either independently spot-verified by me or is corroborated by a passing/failing test I ran myself.

---

## 1. Tenant isolation — P0 category

**Already fixed (verified).** All ~78 API routes under `src/app/api/restaurants/[slug]/**` resolve `restaurantId` exclusively via `resolveRestaurantContext()` (`src/lib/api-route-helpers.ts:58`) — never from client input. Every branch-scoped resource is verified against `requireBranchAccess()` (`src/lib/rbac/guard.ts:99`) or an equivalent inline `and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId))` check before use. Spot-checked ~40 routes for resource-ownership re-verification (order/customer/table/inventory/menu/supplier ids) — no instance of a bare `where(eq(table.id, clientSuppliedId))` found. Realtime/SSE and reorder endpoints also independently verified.

**P1 — no DB-level composite-FK/CHECK backstop for `branch_id` belonging to the same `restaurant_id`.** Every table carrying both columns (`orders`, `restaurant_tables`, `expenses`, `attendance_records`, `purchases`, `stock_movements`, `service_calls`, `reservations`) uses two independent single-column FKs (confirmed live: `SELECT ... FROM pg_constraint WHERE contype='f' AND cardinality(conkey) > 1` returns 0 rows). Today this invariant is fully enforced at the application layer with no gap found — but nothing in Postgres itself would catch a future raw-SQL fix, admin script, or new route that skips the check. **Not fixed this pass** — recommend a composite FK `(restaurant_id, branch_id) REFERENCES branches(restaurant_id, id)` (needs a unique index on `branches(restaurant_id, id)`) before commercial launch; scoped as a standalone schema migration, deferred to keep this pass focused on live bugs over hardening-in-depth with zero found exploit path.

**P2 — `branches/[branchId]/route.ts:81` PATCH's final UPDATE omits an already-verified `restaurantId` re-check** (the preceding SELECT confirms it, the write doesn't re-assert it). Not exploitable — cosmetic inconsistency only.

## 2. RBAC — P0 category

**Already fixed (verified).** 19 granular permissions, all server-resolved (no route reads role/permission from client input). Refund, void, discount-override, payroll, staff-management, settings all gated correctly. Test suite genuinely exercises deny paths — "same restaurant, wrong branch → denied" and "different restaurant → denied" — not just allow paths (`tenant-isolation.test.ts`, `branch-permissions.test.ts`, `menu-tenant-isolation.test.ts`, `tables-tenant-isolation.test.ts`, plus per-domain suites). No P0/P1 findings.

## 3. Database integrity — P0 category

**Already fixed (verified) — no schema/migration drift.** Live DB's table count (41), FK count (93), and every unique index (including 5 partial ones) match `schema.ts` exactly.

**Already fixed (verified) — duplicate active-state protection.** Partial unique indexes correctly protect: one active role-grant per (user, restaurant); one open attendance shift per (user, restaurant); one active service-call per table; duplicate order submission (`clientRequestId`).

**P1 — no idempotency key on `payments`, unlike `orders`.** The `payments` table has no `clientRequestId`/retry-key column and no unique index beyond its PK. The route does correctly guard against *overpayment* (a `FOR UPDATE` lock + remaining-due check), but a legitimate network retry of a *partial* payment (e.g. a dropped response after a Rs 500 tap on a larger bill) can pass that same-amount-remaining check twice and insert two payment rows — a real double-charge risk with no defense. **Fixed this pass** (see §Fixes below).

**P2 — no CHECK constraints anywhere in the schema** for non-negativity (quantities, prices, tax rates, salaries, capacity, party size). App-layer Zod validation was spot-checked across 8 validation modules and found consistently applied — this is a defense-in-depth gap, not a demonstrated bug. **Fixed this pass** for the highest-value columns (see §Fixes below); not exhaustive.

## 4. Concurrency — P0 category

**Already fixed (verified), with real interleaved-transaction tests, not just code review:** inventory stock movement (atomic SQL `+=`), weighted-average purchase costing (`SELECT ... FOR UPDATE`), recipe deduction idempotency (order-status CAS + one-directional state machine), payment/refund recording (`FOR UPDATE` on the order row), reservation creation (`FOR UPDATE` on the table row before overlap check), ledger settlement (CAS on both status AND settled-amount), table/service-call status transitions (CAS), attendance clock-in (partial unique index).

**P1 — reservation status transitions have no compare-and-swap** (`src/app/api/restaurants/[slug]/reservations/[reservationId]/status/route.ts`). Every analogous route in this codebase (orders, tables, service-calls) guards its status UPDATE with `WHERE ... AND status = currentStatus`; this one doesn't. Concrete failure: two staff concurrently PATCH a `confirmed` reservation — one to `seated`, one to `cancelled` — both read the same stale status, both pass `canTransition`, and whichever commits second silently overwrites the other, desyncing the floor plan from reality (e.g. a seated party's table gets released as "available"). **Fixed this pass.**

**P2 — attendance clock-out has no CAS**, allowing a double-tap to overwrite `clockOutAt` with a later timestamp. Low severity (no money at stake, no constraint violated). **Fixed this pass** (cheap, same pattern).

## 5. Payment/order idempotency — P0 category

**Already fixed (verified) end-to-end.** Public QR orders and staff POS orders both use `clientRequestId` backed by a real partial unique index (`orders_restaurant_client_request_id_unique`); a genuine concurrent double-submit is reduced to one order by the constraint itself, not just a pre-check. Gateway payment callbacks re-verify under a `FOR UPDATE` lock before inserting — a double-click/redirect-replay can't double-credit a payment.

**P1 — same gap as §3**, payments lack a matching idempotency key for legitimate retries of a distinct (non-overpayment) amount. **Fixed this pass.**

## 6. Payment state machine — P0 category

**Already fixed (verified)** for the success direction and for trusting the provider, not the client: eSewa is HMAC-verified, Khalti is verified server-to-server via our own stored `pidx`; overpayment is rejected on the manual-payment path and deliberately, narrowly allowed (and flagged) on the gateway path since the money was already collected before the callback runs.

**P0 — the gateway callback's failure path can silently overwrite an already-completed transaction back to "failed," with no guard.** (`src/app/api/payments/gateway/[gateway]/callback/route.ts`). The success path is correctly locked and re-checked; the failure path's `UPDATE ... SET status = 'failed'` has no `WHERE status = 'initiated'` clause. Concrete interleaving: a genuine success (request A, fully verified) and a stale/duplicate redirect delivery whose independent verification errors out (request B — e.g. a transient upstream lookup failure) both pass the early unlocked read before either writes; A commits `completed` with a real payment recorded, then B's unconditional UPDATE clobbers that back to `failed`. The money and the `payments` row are untouched, but the field this same route's own idempotency fast-path reads is now wrong — a subsequent page refresh tells staff/guest the payment failed when it actually succeeded. Reclassified from the auditing subagent's P1 to **P0**: this is exactly the "prevent voided→paid / paid→failed" state-machine regression the spec calls out, with real staff-facing financial-UX consequences (a customer could be charged twice if staff re-attempt collection believing the first payment failed). **Fixed this pass.**

## 7. Financial ledger — P0 category

**Already fixed (verified)** across every flow inspected (sales, expense payment, purchase, payroll payment, due settlement) — the primary write and its ledger counterpart are always inside the same `db.transaction`, so a failure can't leave one without the other.

**P2 — test coverage gap, not a bug.** Rollback-on-failure is tested for inventory; not yet tested for the expense/purchase/payroll ledger pairings specifically, though the code pattern is structurally identical to the tested case. Not fixed this pass (large test-authoring effort for a demonstrated-safe pattern; noted for backlog).

## 8. Inventory — P0/P1 category

**Already fixed (verified), including live test runs.** `recordStockMovement` atomically updates both the restaurant-wide and branch-level stock in one transaction; recipe deduction fires exactly once per order via the order-status CAS; weighted-average costing is race-safe under `FOR UPDATE`. Negative stock is possible and is an intentional, documented tradeoff (stock isn't hard-blocked at sale time).

**P1 — COGS and revenue in Reports do not exclude refunded completed orders.** There is no `refunded`/`voided` order status (`completed` is terminal); refunds only touch `orders.paymentStatus`, never `orders.status`. Since `getSalesSummary`/`getCogsSummary` key purely on `status = "completed"`, a fully refunded order still counts its full amount as revenue and its full recipe cost as COGS in every Reports figure — only the payment-method breakdown (which sums signed `payments` rows directly) nets refunds out correctly. Untested as well as unfixed (no refund scenario in `cogs-reporting.test.ts`). **Fixed this pass.**

## 9. Physical stock count (P2-3) — does not exist

Confirmed absent end-to-end: no table, no migration, no route, no UI. `BRANCH_INVENTORY.md` itself already lists this as future work. **Not built this pass** — scoped as a standalone P1 feature for the next phase (system-vs-counted quantity, variance, user/timestamp/reason/branch/cost-impact).

## 10. Branch-to-branch stock transfer (P2-7) — foundation only, transfer feature does not exist

The branch-scoped storage foundation (`branch_inventory_levels`, required `branchId` on purchases/stock_movements) is built and verified. The actual transfer flow — a `stock_transfers` table, request→approve→dispatch→receive→variance, API, UI — does not exist. **Not built this pass.**

## 11. Restaurant timezone — P0 category

**Already fixed (verified), with dedicated regression tests at the exact Kathmandu midnight-crossing case.** Every business-day-boundary call site (order numbering, KOT ticket dates, loyalty streaks/birthdays, ledger entry dates, expense dates, reports, reservations) routes through `restaurant-date.ts`'s `Intl.DateTimeFormat`-based helpers, not raw UTC. `expenseDate`/`entryDate` columns' `.defaultNow()` DB defaults are a latent trap but are never actually relied on — every insert path explicitly supplies the restaurant-local date instead.

## 12. Reservations — P0/P1 category

**Already fixed (verified).** Concurrent double-booking for the same table+overlapping time is genuinely serialized via `FOR UPDATE` + an in-transaction overlap check — not a check-then-act race. Branch isolation and cancellation/table-release both verified correct.

**Covered under §4** — the missing CAS on status transitions (reclassified P1, fixed this pass) is the one real gap here.

**P2 — reservation time entry in the dashboard UI uses the browser's local timezone, not the restaurant's.** Backend bucketing is fully correct; only the staff-facing input/display in `ReservationsBoard.tsx` would be off if a device's clock isn't set to Asia/Kathmandu. Not fixed this pass (low real-world severity for an on-premise device).

## 13. Table management — P1 category — does not exist

Table transfer, merge, split, "move order to another table," and hold/resume order all confirmed absent (no schema, no routes, no UI). **Not built this pass** — backlog item.

## 14. Cash register / shift management — P1 category — does not exist

Confirmed absent end-to-end (schema, API, dashboard nav all checked) — no opening/closing cash, no cash-sales/expense/drop tracking against a shift, no expected-vs-actual variance, no manager approval flow. The only "shift" concept in the codebase is unrelated staff attendance clock-in/out. **Not built this pass** — this is a substantial, from-scratch feature (§17 of the master prompt); scoped honestly as a P1 backlog item rather than attempted as a rushed, under-tested addition in this pass. See "Recommended next features" below.

## 15. End-of-day closing — P1 category — does not exist

Reports is a live, always-current query surface with no "closed"/"locked" concept at all — confirmed no `dailyClosing`/`closed_at`/finalize/lock construct anywhere. Concretely verified that historical numbers CAN shift after the fact: `expenses` accepts a backdated `expenseDate` with no minimum bound, and an edited/voided expense changes what a previously-viewed day's report shows on next load, with nothing to flag or prevent it. **Not built this pass** — same rationale as cash register; the two are natural to build together (EOD closing typically needs a shift-close event to hang off of). Backlog item.

## 16. Supplier / vendor dues (accounts payable) — P1 category — does not exist

`purchases` has no `amountPaid`/`amountDue`/`dueDate`/payment-status columns; no payment-against-purchase endpoint exists. The route's own comment states credit purchases are meant to be tracked via a completely separate, unlinked manual Account Books entry. **Not built this pass** — backlog item (needs: due-date + amount-due on purchases, a payments-against-purchase endpoint, integration with the existing ledger `dueStatus` mechanism which already exists generically).

## 17. Payroll — P1 category — exists partially

What's real: a per-staff flat salary config plus an append-only, manually-typed payout log with void support, correctly posting to the shared ledger with the staff member's identity withheld from that shared view. What's absent: attendance-based calculation (attendance records and payroll are never joined), overtime, bonus/deduction fields, an approval workflow, and payslip generation. No statutory tax logic exists (correctly out of scope per the master spec). **Scope-honesty finding, not a bug** — not built out further this pass; flagged so the product isn't described as "complete payroll" without qualification.

## 18. Accounting honesty — no finding

**Already fixed (verified) / not applicable.** The codebase is explicitly self-aware that "debit"/"credit" in Account Books means cash-book bookkeeping, not double-entry accounting — this is stated in the schema's own comment. No overclaiming copy was found anywhere in the product UI, marketing page, or README; "Account Books" and "ledger" are used consistently instead of "accounting."

## 19. Audit log — P1 category — backend complete, UI does not exist

`recordAuditLog()` is genuinely called from 55+ route files, covering every required action (refund, void, delete/deactivate, role change, salary change, expense lifecycle, inventory adjustment, purchase, payment, settings changes) — no coverage gaps found. But `auditLogs` has zero read paths: no GET endpoint, no dashboard page. **Fixed this pass** (a read endpoint + a simple owner-facing Activity Log page — the backend work is already done, this is a much smaller lift than the other missing-feature items).

## 20. Data export — P1 category — does not exist

No CSV/Excel/PDF export exists for any module (sales, orders, payments, expenses, inventory, purchases, suppliers, customers, attendance, payroll, Account Books). **Not built this pass** — broad backlog item spanning many modules; scoping and building even one well (with pagination/streaming for large exports) properly is a meaningful chunk of work on its own.

## 21. Account recovery — P0/P1 category — does not exist

No forgot-password/reset-password flow, no self-service change-password for an existing account, no "logout all other sessions." Where auth exists, it's implemented well (account-enumeration avoidance verified on both login and register, timing-safe compare, generic errors). **Partially fixed this pass**: self-service change-password and logout-all-sessions were added (no external dependency needed, moderate scope). Full forgot-password (needs an email/SMS delivery decision, token flow, rate limiting, single-use expiry) was **not** built this pass — flagged as a P1 backlog item, since a half-built reset flow shipped in one pass would be a worse outcome than a clearly-scoped follow-up.

## 22. MFA/2FA — P1 category — does not exist

No TOTP/second-factor for owner or platform-admin. Per the master spec, this is documented as P1, not a launch blocker. **Not built this pass.**

## 23. Security headers — P0 category

**Already fixed (verified).** Full CSP with HSTS/X-Frame-Options/X-Content-Type-Options/Referrer-Policy/Permissions-Policy, cross-checked against every real usage (Web Push, AI, eSewa form-POST, Khalti redirect, Sentry tunnel, no next/image, no external fonts) — all correctly accommodated with nothing broken. `'unsafe-inline'` in script-src/style-src is a real, explicitly-reasoned, documented tradeoff (not an oversight) with concrete justification in the code comments.

**P2 — header regression tests don't cover script-src/style-src/connect-src values**, only the baseline directives. Not fixed this pass.

## 24. Rate limiting — P0/P1 category

**Already fixed (verified) for endpoint coverage** — every unauthenticated/public endpoint (login, register, public QR order, service-call, gateway callback, AI assistant) has rate limiting; authenticated dashboard routes correctly rely on session+permission checks instead.

**P1 — the in-memory mechanism is correct for the actual (Hostinger single-process) deploy target, but the README also documents Vercel and PM2-cluster as supported alternates**, both of which would silently multiply every limit by the instance/worker count with no code-level guard. **Fixed this pass** by correcting the documentation to state the single-instance requirement explicitly rather than presenting multi-instance-incompatible deploy targets as equally valid — a code-level distributed-store migration (Redis) was judged out of scope for this pass given the actual deployment target doesn't need it today, but the docs must stop recommending configurations that would silently break it.

**P1 — `getClientIp()` trusts `X-Forwarded-For`/`X-Real-IP` verbatim with no trusted-proxy allow-list.** If the app is ever directly internet-reachable, or sits behind a proxy that doesn't overwrite inbound headers, an attacker can spoof this header to defeat every IP-keyed rate limit. **Fixed this pass.**

## 25. Push / SSE — P0 category

**Already fixed (verified), including live test runs (15/15 passing).** The "filter after LIMIT" bug class this project fixed once before was specifically re-checked and confirmed absent everywhere in current realtime code — both event fetchers filter branch scope inside the SQL WHERE clause, before LIMIT. Web Push branch isolation is SQL-level and tested. SSE endpoint requires auth+membership before any stream starts. No memory-leak vector found (self-terminating streams + native EventSource reconnect).

## 26. Offline POS — P0/P1 category

**Already fixed (verified) — this is a real offline order-creation flow, not just offline viewing.** IndexedDB-backed queues genuinely wired into the POS UI; sync-exactly-once enforced by the same `clientRequestId` + unique-index mechanism as online orders, on both the client (retry-safe) and server (constraint-backed) sides. Payment-linked order completion is deliberately excluded from the offline queue — confirmed no path lets a client-side flag mark a gateway payment as "completed" without server verification. No PWA service worker exists (offline means "queue survives," not "app shell loads with no network") — worth noting in release copy so it isn't oversold. No findings requiring a fix.

## 27. QR system — P1 category

**Already fixed (verified)** for entropy (256-bit CSPRNG) and scoping (unique-indexed, single-join resolution to exactly one table/branch/restaurant).

**P1 — no revocation/regeneration mechanism.** Once generated, a table's QR token can never be rotated — no way to neutralize a leaked/photographed code short of deleting and recreating the table. **Fixed this pass.**

## 28. POS edge cases — P0/P1 category

**Already fixed (verified).** Server always recalculates authoritative prices; zero/negative quantity, deleted/inactive items, mid-checkout price changes, and discount-exceeding-subtotal are all correctly handled. No findings.

## 29. Customer credit — P1 category — does not exist

No credit limit, credit sale, or customer statement construct tied to `customers`. **Not built this pass** — backlog item.

## 30. Combos / Coupons — P2 category — do not exist

Both confirmed absent. Correctly deprioritized per the master spec's own instruction not to build these ahead of P0/P1 work. **Not built this pass.**

## 31. Order status history — P1 category — does not exist

Only current `status` + a single `updatedAt` — no per-transition timeline. The project's own Reports code already documents this exact limitation in its own doc comments (`getCompletionStats`). Blocks real per-stage SLA/kitchen-prep-time metrics. **Not built this pass** — would need a schema addition (at minimum a `completedAt` column, ideally a full history table) plus wiring through every status-transition call site; scoped as a backlog item rather than a partial/rushed addition.

## 32. Reports — P1 category

**Already fixed (verified).** Every report function is restaurant/branch-scoped, timezone-correct, and excludes cancelled orders from revenue. The refund-exclusion gap is the same finding as §8, fixed this pass. `avgCompletionMinutes`'s `updatedAt`-based approximation is a known, self-documented limitation, not a defect.

## 33. Website builder — no finding

**Already fixed (verified).** Public route strictly slug-scoped, no cross-tenant leakage path. Custom domains absent, correctly treated as P2/non-blocking per spec.

## 34. AI — no finding

**Already fixed (verified).** Tenant isolation, prompt-injection surface (only aggregated, staff-authored data reaches the prompt — never raw customer/order free text), rate limiting, and error handling (no internal detail leakage) all verified. Marketing copy matches actual capability.

## 35. Printing — P0 category

**Already fixed (verified) for what genuinely works.** Both the browser-print path and the real Web Serial ESC/POS thermal-printer integration are functional, not aspirational, and both are honestly scoped in-code (a human still confirms the OS print dialog; thermal mode requires one-time manual pairing, Chrome/Edge desktop+Android only).

**P0 — ESC/POS control-character injection via unsanitized order/item notes.** `EscPosBuilder.line()` writes raw UTF-8 bytes with no control-character stripping. `order.notes`/`orderItem.notes` are only length/trim-validated and are directly editable from the **unauthenticated public QR order page** — for any restaurant with direct thermal printing enabled (an opt-in but realistic configuration), a customer can type raw control bytes into an order note (e.g. an ESC/POS cut command, or a cash-drawer-kick sequence some printers expose on the same command set) and have them sent, unfiltered, to a physical printer connected to the restaurant's till. This is reachable by any anonymous customer scanning a table's QR code, with physical-hardware consequences up to and including an unauthorized cash-drawer kick — reclassified from the auditing subagent's P1 to **P0** given it's an unauthenticated, remotely-triggerable path with real-world physical impact. **Fixed this pass.**

## 36. Mobile / responsive, Accessibility, Performance — P2 category (spot checks, not exhaustive)

No P0/P1 findings in any of the three. Mobile: consistent use of Tailwind responsive classes, no fixed-pixel-width breakage found; a few touch targets below the 44px guideline. Accessibility: no `role="dialog"` used anywhere (confirmed codebase-wide), a handful of icon-only buttons lack `aria-label`. Performance: no genuine N+1 in report/list SQL; a few hard-capped, unpaginated lists (customers at 200, inventory items unbounded) that would need real pagination at meaningfully larger scale. None fixed this pass — explicitly out of the P0/P1 priority band per the master spec's own ordering (security/data-integrity/financial-correctness ahead of these).

## 37. Database migrations — no finding

**Already fixed (verified), actually executed.** All 33 migrations applied cleanly against a genuinely fresh scratch database this session, followed by the required seed step; row/table/FK counts matched the populated dev DB exactly afterward. CI runs the same migrate+seed sequence against a fresh Postgres container on every push.

## 38. Dependency audit — mixed

`npm audit`: 7 vulnerabilities (4 moderate — `esbuild`, dev-tooling-only via `drizzle-kit`, never invoked in production; 3 high — `postcss`+`sharp`, both bundled inside `next` itself). Confirmed no non-breaking fix exists within the 15.x line (15.5.23 is the newest 15.x release available). Confirmed `sharp`/libvips CVEs are **not reachable at runtime** — `next/image` is never imported anywhere in this app (all restaurant images render via plain `<img>`, by deliberate design per an in-code comment), so no attacker-controlled bytes reach sharp through any code path this app actually exercises. **Recommendation: defer the `next@16` major upgrade** — track as a normal post-launch upgrade, not a blocking fix.

**P1 — time-sensitive, not fixable yet.** Next.js has a pre-announced critical-severity security release scheduled for **August 26, 2026** (`16.3.3`/`15.5.24`), per Vercel's own pre-announcement — details are embargoed until it ships, so nothing can be assessed or fixed against it today. Flagged here as a tracked action item: upgrade to `next@15.5.24` (a same-line, non-breaking patch) as soon as it's published.

## 39. CI/CD — no finding

**Already fixed (verified).** Correct step order, real Postgres service container, no `continue-on-error` anywhere, no hardcoded secrets (CI-only dummy values with an explicit in-file explanation of why they're safe).

## 40. Error monitoring (Sentry) — P1 category

**Already fixed (verified) for redaction** — genuinely strips passwords, phone numbers, names, emails, PAN/VAT, cookies/auth headers, tokens, session ids from every captured event, tested, on top of disabling body/cookie collection at the SDK level. Ships correctly inert-by-default with an honest in-repo explanation (no Sentry project has been created for this instance).

**P1 — the dominant class of "API failure" never reaches Sentry even when a DSN is configured.** The shared error handler used by ~76 routes (`toErrorResponse()`) only `console.error`s an unhandled exception and returns a generic 500 — it never calls `Sentry.captureException`. A full-repo search confirms zero `captureException` call sites in application code; the only wired hook (`onRequestError`) only fires for errors that escape uncaught, which this app's own catch-everything pattern prevents. **Fixed this pass.**

**P2 — bank-account fields aren't in Sentry's redaction key list.** Currently unreachable (no `captureException(err, {extra})` call sites existed before this pass's fix) but worth closing now that one is being added. **Fixed alongside the P1 fix above.**

## 41. Backup/restore — no finding

**Already fixed (verified), a real executed restore test** (not a theoretical runbook) — concrete row/table counts, both P0-hardening partial unique indexes confirmed intact post-restore. The one honestly-flagged gap (no automated/scheduled backup) is pre-existing documentation, not new.

## 42. Production environment — P2 category

**P2 — `AUTH_SECRET` is documented and provisioned as required but is never read anywhere in application code** (sessions use a random opaque DB-backed token, not a JWT). Dead configuration that invites confusion during incident response. **Fixed this pass** (documentation correction).

**P2 — deploy-platform documentation is inconsistent** (README describes Vercel, `netlify.toml` exists, but the actual production target per other docs is Hostinger). **Partially addressed this pass** as part of the rate-limiting doc fix (§24) — full reconciliation of all three left as a smaller follow-up.

No undocumented-but-used environment variables were found; no hardcoded dev-secret fallbacks were found; `.env.local` is correctly gitignored.

## 43. Documentation — P2 category

**P2 — README carries "Phase N ... fully complete" internal build-log narration** that reads as aspirational/dev-session artifact rather than a stable product description for an external reader. Not fixed this pass (cosmetic, non-blocking, would need a broader README pass than fits this session's budget alongside the fixes above).

## 44. Legal/compliance (Nepal) — not applicable

No IRD/e-billing/PAN-VAT compliance claim exists anywhere in the codebase or marketing copy to verify. `panVat` is a free-text business field with no validation or invoice-generation logic tied to it. Background research confirms Nepal's IRD does operate a "Verified Computer Billing Software" registration process, but RestroMitra makes no claim to hold or need it — nothing to fix or flag as false.

---

## What this audit did NOT find

Zero P0 findings in tenant isolation, RBAC, core concurrency (order/payment/inventory/reservation locking), migration safety, restaurant-timezone correctness, security headers, push/SSE isolation, POS edge cases, offline sync, or AI/website tenant scoping — all independently re-verified against current source, several with live test runs, not accepted on the strength of prior commit messages. This is a meaningfully strong foundation for a controlled pilot.

## What this pass fixes (see commits)

Every item below actually landed as code — implemented, regression-tested, and verified against `npx tsc --noEmit` / the full test suite / `npm run lint` / `npm run build` after EACH commit, not just after the final one. 13 commits, `3601424` (baseline) → `891bb74` (final):

1. `8574dcc` **fix(payments)** — payments idempotency key (`clientRequestId` + partial unique index) and 14 DB-level CHECK constraints across money/quantity columns.
2. `1124035` **fix(finance) — P0** — gateway-callback failure-path status-downgrade race (extracted `markGatewayTransactionFailed`, locked + re-checked before writing).
3. `35fb26e` **fix(security) — P0** — ESC/POS control-byte injection (`sanitizeForPrinter` in `EscPosBuilder.line()`).
4. `3745949` **fix(concurrency)** — reservation status transitions gained a compare-and-swap.
5. `eb622d7` **fix(concurrency)** — attendance clock-out gained a compare-and-swap.
6. `9f73938` **fix(reports)** — `getSalesSummary`/`getCogsSummary` now exclude/net refunds against completed orders.
7. `ecd6d12` **fix(security)** — `getClientIp()` hardened against X-Forwarded-For spoofing (`TRUSTED_PROXY_COUNT`).
8. `8b0613c` **fix(observability)** — unhandled API errors now reach Sentry via `toErrorResponse()`; bank-account fields added to the redaction pattern.
9. `64bdb9b` **docs(release)** — corrected the rate-limiting deploy-platform guidance (Vercel/pm2-cluster aren't drop-in equivalents) and the `AUTH_SECRET` documentation (never actually read).
10. `984545a` **feat(audit-log)** — a read endpoint + Activity Log dashboard page for `audit_logs` (the write side has existed since Phase 2).
11. `58fce0e` **feat(security)** — QR code revocation/regeneration for tables.
12. `891bb74` **feat(security)** — self-service change-password + logout-other-sessions.

Final state: 696 tests passing (92 files, up from the 648/81 baseline), 5/5 E2E passing, `tsc`/lint/build all clean. See `RELEASE_READINESS.md` for the full scorecard and score.

## What remains explicitly unbuilt (backlog, not attempted this pass)

Cash register/shift management, end-of-day closing, supplier dues/AP, data export, full forgot-password flow, MFA, order status history, physical stock count, branch-to-branch transfer feature, table transfer/merge/hold-resume, customer credit, combos, coupons. Each is a genuine, scoped feature build (some substantial — cash register and data export especially), not a bug fix, and building any of them well — with the same test rigor as everything above — is more work than fits honestly alongside fixing the confirmed bugs in one pass. See `RELEASE_READINESS.md` for the full scorecard and prioritized recommendation.
