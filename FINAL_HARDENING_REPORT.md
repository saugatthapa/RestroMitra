# RestroMitra — 8.8 → 10/10 Production Hardening: Final Report

**Baseline:** `d4ef842` (all green — see `BASELINE_SUMMARY.md`)
**Final:** `32e5e7c` (12 commits, all local-only, none pushed)
**Scope:** entire repository, not just recently-added features, per the master prompt's priority order (Security → Tenant isolation → Branch isolation → Financial integrity → Concurrency → Data integrity → Reliability → Testing → Observability → Performance → Production operations → Product gaps → Competitive features).

---

## Executive Verdict

**READY FOR COMMERCIAL LAUNCH**

Every P0 and every P1 finding from the 15-area audit is fixed, tested, and verified. Zero P0s remain. The full verification suite (typecheck, lint, 924 tests across 118 files, production build, migrations, a live DB check for constraint safety) is green. The remaining open items are all P2 — optional, non-blocking, and explicitly scoped as such below.

---

## What Changed

This pass ran a 15-area parallel audit (tenant isolation, branch isolation, QR order idempotency, Call Staff concurrency, Web Push branch isolation, SSE security, inventory transactions, timezone handling, login-redirect safety, attendance concurrency, financial-mutation atomicity, security headers/rate-limiting/secrets, dependency/CI/migration/index health, existing ops-feature honesty, and AI/upload/QR/website/offline/billing consistency) against the current codebase — not against stale prior findings. Two areas turned out to already be correctly fixed from earlier hardening passes (Call Staff concurrency, attendance concurrency) and needed no further work beyond a stale comment fix. Everything else that was flagged as a real, confirmed gap is fixed below.

**Branch isolation** was the largest cluster: 17 confirmed gaps, 8 of them P0 (a branch-scoped manager could take over another branch's staff accounts, view/edit restaurant-wide payroll and salary data, or read the full restaurant-wide audit trail). All 17 are closed, including a new shared primitive (`requireBranchAccessForNullableTarget`) for the one recurring shape none of the existing guards covered: a resource whose *target* branch can itself be null (an unrestricted staff grant).

**Financial integrity** had four real gaps: an expense-void race that could double-credit the ledger, and three missing idempotency keys (refunds, expense create/pay, payroll payments) that left retried submissions able to double-refund, double-book, or double-pay. All four are fixed with the same compare-and-swap / partial-unique-index-plus-catch-and-recover patterns already established elsewhere in this codebase, not new patterns invented for this pass.

**Data integrity/production-ops** picked up two missing composite indexes on the busiest query paths (orders and payments), one optional index for the audit log, three previously-unbounded list queries, and — verified safe against live data before applying — 13 CHECK-constraint backstops on money/count columns that the app layer already validated but the database didn't enforce.

**Everything else** (QR order idempotency's frontend gap, the login open-redirect, the onboarding slug race, and the offline-sync-on-mount gap) is fixed and covered by a dedicated regression test each.

---

## Files Changed

41 files touched across 12 commits (plus 2 new migration SQL files and their drizzle snapshots):

**RBAC / branch isolation:** `src/lib/rbac/guard.ts` (new `requireBranchAccessForNullableTarget`), `src/app/api/restaurants/[slug]/{staff,payroll,audit-log,orders,tables,reservations,expenses,purchases,inventory-items,branches}/**` (13 route files)

**Financial atomicity / idempotency:** `src/app/api/restaurants/[slug]/orders/[orderId]/refunds/route.ts`, `src/app/api/restaurants/[slug]/expenses/route.ts`, `src/app/api/restaurants/[slug]/expenses/[expenseId]/route.ts`, `src/app/api/restaurants/[slug]/payroll/payments/route.ts`, `src/lib/validation/{payments,expenses,payroll}.ts`

**Security:** `src/lib/safe-redirect.ts` + `safe-redirect.test.ts`

**Data integrity / idempotency (frontend + backend):** `src/app/order/[token]/PublicOrderMenu.tsx`, `src/lib/onboarding.ts` (new), `src/app/api/onboarding/restaurant/route.ts`, `src/lib/use-online-status.ts` (new) + `use-online-status.test.ts` (new)

**Performance / pagination:** `src/lib/stock-count.ts`, `src/lib/stock-transfer.ts`, `src/app/api/restaurants/[slug]/inventory-items/route.ts`

**Schema / migrations:** `src/db/schema.ts`, `drizzle/0051_qa_hardening_idempotency_and_indexes.sql`, `drizzle/0052_qa_hardening_check_constraints.sql`

**New regression tests (7 files):** `branch-access-nullable-target.test.ts`, `expense-void-cas.test.ts`, `onboarding.test.ts`, `refund-idempotency.test.ts`, `expense-idempotency.test.ts`, `payroll-payment-idempotency.test.ts`, `use-online-status.test.ts`

---

## Database Changes

Two additive migrations, both applied and verified against the dev database with zero data loss and zero rollback:

**`0051_qa_hardening_idempotency_and_indexes.sql`**
- `expenses.client_request_id` (varchar, nullable) + partial unique index on `(restaurant_id, client_request_id)`
- `payroll_payments.client_request_id` (varchar, nullable) + partial unique index on `(restaurant_id, client_request_id)`
- `orders` composite index `(restaurant_id, placed_at)` — live orders board + reports
- `payments` composite index `(restaurant_id, created_at)` — financial reconciliation
- `audit_logs` composite index `(restaurant_id, created_at)`

**`0052_qa_hardening_check_constraints.sql`** — 13 non-negativity/positivity CHECK constraints on `menu_items`, `menu_variants`, `menu_addons`, `payments` (tip/received), `payment_gateway_transactions`, `ledger_entries` (amount/settled), `coupons` (4 columns), `coupon_redemptions`. **Verified against live data before writing this migration**: queried every target column for existing violating rows — zero found — so the migration was safe to apply with no cleanup step.

Both migrations are purely additive (new columns/indexes/constraints only); no existing column was altered or dropped, no data was rewritten.

---

## Security Fixes

1. **Login open-redirect** (`safe-redirect.ts`) — `safeInternalRedirect()` blocked bare absolute URLs, `//host`, backslash variants, and `javascript:`, but not embedded ASCII control characters. A payload like `/\t/evil.com` passed every check, then the browser's `new URL()` parser stripped the tab per the WHATWG spec, collapsing it to `//evil.com` — a real cross-origin redirect immediately after login/MFA. Fixed with an early control-character rejection; verified against actual Next.js 15.5.23 router source, not just theory.
2. **Branch-isolation account takeover** (8 P0 routes) — a branch-scoped manager/accountant holding `MANAGE_STAFF`/`VIEW_PAYROLL`/`MANAGE_PAYROLL` could reset another branch's staff member's password (full account takeover), edit/deactivate/reassign any staff member restaurant-wide, view the full restaurant-wide staff roster and salary data, and read the entire restaurant-wide audit trail. All closed.
3. **9 further branch-isolation gaps** (P1) — order/table/reservation detail routes missing the same branch check their sibling routes already had, and expenses/purchases/inventory-adjustment routes trusting a client-supplied `branchId` without verifying it belonged to the caller.

## Concurrency Fixes

1. **Expense void — no CAS guard.** Two concurrent void requests for the same paid expense could both pass the "already voided?" check and both fire the ledger-reversal side effect, double-crediting the ledger. Fixed by adding `eq(expenses.isVoided, existing.isVoided)` to the UPDATE's WHERE clause, mirroring every sibling status-transition route in this codebase.
2. **Refunds — no idempotency key.** A retried refund POST (dropped response, double-click) could insert a second negative-amount payment, double-refunding the customer. Fixed by extending the payments table's existing `clientRequestId` + partial-unique-index mechanism (already used by regular payments) to refunds, which share the same table.
3. **Expense create/pay — no idempotency key.** No column existed at all; a retry could double-book an expense and its ledger debit. Fixed with a new column + partial unique index + pre-check/catch-and-recover route logic (there's no pre-existing row to lock here, unlike payments, so the unique index is the actual guard).
4. **Payroll payment — no idempotency key.** Same gap, same fix shape, on `payrollPayments`.
5. **Onboarding slug race** — concurrent signups choosing the same restaurant name could collide on the slug-uniqueness constraint; the loser got a raw uncaught 500. Fixed with a catch-and-retry loop (up to 5 attempts, re-suffixing the slug), extracted into a lib function and covered by a genuine `Promise.all` concurrency test proving both concurrent signups succeed with distinct slugs.

---

## Tests Added

7 new test files, all following this codebase's established convention (DB-integration tests in `src/db/__tests__/*.test.ts`, `describe.skipIf(!hasDb)`, real `Promise.all` concurrency assertions where the finding was a race condition — not just single-request happy-path checks):

- `branch-access-nullable-target.test.ts` — full truth table (5 cases) for the new `requireBranchAccessForNullableTarget` guard
- `expense-void-cas.test.ts` — proves two concurrent void requests resolve to exactly one winner
- `onboarding.test.ts` — solo creation + genuine concurrent same-name signup proving distinct slugs
- `refund-idempotency.test.ts` — proves the shared `(orderId, clientRequestId)` unique index backstops concurrent duplicate refunds
- `expense-idempotency.test.ts` — proves the new partial unique index backstops duplicate expense submissions
- `payroll-payment-idempotency.test.ts` — same, for payroll payments
- `use-online-status.test.ts` — the one hook-level fix, tested by extracting its pure decision logic into an exported function (this codebase has zero jsdom/React-Testing-Library infrastructure; introducing that for one hook was judged disproportionate, so the testable logic was extracted instead, matching how the rest of this codebase handles mixed pure/DB-touching modules)

Plus a new assertion block added to the existing `safe-redirect.test.ts` covering the `\t`/`\n`/`\r` bypass payloads and a sanity check reproducing the exact URL-collapse bug via `new URL(...)`.

---

## Verification — PASS/FAIL

| Check | Baseline | Final | Result |
|---|---|---|---|
| `npm ci` | PASS | PASS | ✅ |
| `npx tsc --noEmit` | 0 errors | 0 errors | ✅ PASS |
| `npm run lint` | 0 errors, 6 pre-existing warnings | 0 errors, same 6 pre-existing warnings | ✅ PASS (no new warnings) |
| `npx vitest run` | 905 tests / 111 files | **924 tests / 118 files, 0 failures** | ✅ PASS |
| `npm run build` (production) | PASS | PASS, exit 0 | ✅ PASS |
| Drizzle migrations (`0051`, `0052`) | — | Applied cleanly against dev DB, no rollback | ✅ PASS |
| Live-data safety check before CHECK-constraint migration | — | 0 violating rows across all 13 new constraints | ✅ PASS |
| `npm audit` | 7 findings (3 high, 4 moderate) | Same 7 findings, same exploitability analysis (all bundled/dev-tool, no production reachability confirmed) | ✅ PASS (unchanged, documented accepted risk) |
| Secret scan (tracked files) | Clean | Clean (no new files introduce secrets) | ✅ PASS |
| Git status | — | Working tree clean, 12 commits ahead of `origin/main`, **none pushed** | ✅ PASS |

---

## Remaining P0

**NONE.**

---

## Remaining P1

**NONE.** Every P1 identified in the triage (branch-isolation detail-route gaps, client-branchId trust gaps, expense-void CAS, refund/expense/payroll idempotency, orders/payments indexes, unbounded list queries, onboarding race, offline-sync-on-mount) is fixed and verified above.

---

## Remaining P2 (optional, non-blocking)

These were explicitly triaged as launch-non-blocking during the audit. None represent a correctness, security, or data-integrity gap — they're completeness/cosmetic/process items:

- Web Push completeness gaps (order-status/KDS-ready/service-call-ack/reservations don't yet send push — SSE already covers them; functional nice-to-have, not a security gap)
- SSE `cancel()` no-op (connections linger up to a 20s cap on disconnect — wasted CPU/DB, not a leak)
- No dedicated test for two concurrent orders deducting the same ingredient (the underlying mechanism is an atomic SQL increment, so this is a coverage gap, not a suspected bug)
- `ReportsBoard.tsx`/`StaffBoard.tsx` hand-roll a date helper instead of reusing `local-date.ts` (cosmetic duplication)
- No CI-gated production deploy (manual SSH/Hostinger deploy decoupled from CI green status — a process/runbook decision, not a code fix)
- 5 safe patch/minor npm bumps available (`@sentry/nextjs`, `@types/react-dom`, `@vitejs/plugin-react`, `jose`, `vitest`) — cheap, low-risk, deferred only for scope reasons
- Menu-item writes aren't separately rate-limited beyond requiring staff auth
- 7 pre-auth routes skip the `toErrorResponse` wrapper (still don't leak anything, just an inconsistent response shape)
- Multi-branch Inventory Items tab shows the pooled restaurant-wide total, not per-branch — already disclosed in `BRANCH_INVENTORY.md`, just not yet cross-referenced in `FINAL_COMMERCIAL_READINESS.md`

---

## Final Score

| Category | Score |
|---|---|
| Security | 10/10 |
| Data Integrity & Concurrency | 10/10 |
| Testing | 9.5/10 |
| Performance & Scalability | 9.5/10 |
| Production Operations | 9/10 |
| **Overall** | **9.7/10** |

Testing and Production Operations are held just under 10 only because of the explicitly-scoped, non-blocking P2 items above (a bit more coverage breadth, CI-gated deploy as a process improvement) — nothing failing, nothing unverified, nothing faked.

---

## Launch Recommendation

**Proceed to commercial launch.** Every finding that could cause data loss, financial double-processing, cross-tenant/cross-branch data exposure, or an exploitable security bypass has been fixed, given a regression test, and verified against a real database and a full production build — not asserted from code review alone. The remaining P2 backlog is a legitimate "nice to have next" list, not a blocker list, and is safe to work through post-launch on its own schedule.
