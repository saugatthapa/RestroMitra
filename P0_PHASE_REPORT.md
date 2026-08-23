# RestroMitra — Phase 1 (P0) Hardening: Interim Report

**Scope of this report:** only the 10 P0 items from your master prompt's Phase 1. Phase 2 (P1: CI/CD, E2E, monitoring, security headers, rate limiting, backups) and Phase 3 (P2: cash register, COGS, supplier dues, etc.) have **not been started** — per your own instruction not to touch P1/P2 until P0 is stable, and per Rule 7 ("zero bugs" is not a claim I will make and "should work" is not a substitute for a run command).

Everything below was verified by actually running the commands shown, not inferred. Every fix has a real regression test that I confirmed **fails against the pre-fix code and passes against the fix** (for the timezone bug I did this literally — reverted the fix with `git stash`, watched the new tests fail, restored it, watched them pass).

## Fixed (7 of 10)

**P0-7 — Login open redirect.** `src/app/(auth)/login/page.tsx` read `?next=` from the URL and passed it straight into `router.push()` with no validation — `/login?next=https://evil.com` would silently redirect a successful login off-site (verified this is a real full-page navigation in this Next.js version, not a no-op). Added `src/lib/safe-redirect.ts` (`safeInternalRedirect`) — only a same-origin path starting with a single `/` is allowed; `//evil.com`, `/\evil.com`, and `javascript:` schemes all fall back to `/dashboard`. 9 new tests in `safe-redirect.test.ts`.

**P0-3 — Call Staff race condition.** The "Call staff" button's duplicate-prevention was a plain SELECT-then-INSERT with no locking — two near-simultaneous taps could both pass the check and create two active calls. Added `service_calls_one_active_per_table_unique`, a partial unique index (WHERE status IN pending/acknowledged) — the same pattern already used for `user_roles`/`orders` elsewhere in this codebase. The route now catches the resulting 23505 and returns the winning call instead of erroring. Migration `drizzle/0028_misty_morlocks.sql`. 5 new tests, including one that fires two real concurrent inserts via `Promise.all` and confirms exactly one wins.

**P0-8 — Attendance open-shift concurrency.** Same shape of bug as P0-3, already self-documented as a known gap in the route's own comment. Added `attendance_records_one_open_shift_per_user_unique` (partial, WHERE clock_out_at IS NULL). Migration `drizzle/0029_busy_white_tiger.sql`. 5 new tests.

**P0-5 — Inventory weighted-average cost race.** `applyPurchaseCosting` computed the new weighted-average cost in JS from a plain SELECT, then wrote it — under Postgres's default READ COMMITTED isolation, two concurrent purchases of the same item could both read the same stale cost/stock and the second UPDATE would silently overwrite the first, losing that purchase's price contribution forever (stock *quantity* was always safe — only the cost calculation was vulnerable). Added `.for("update")` to the SELECT, matching the row-locking pattern already used in `tables.ts` and the payments/refunds routes. 2 new tests — one deliberately interleaves a held-open transaction against a real concurrent purchase and proves the second call blocks and then sees the first's committed result.

**P0-1 — Branch authorization gap.** `requireBranchAccess()` skipped its own branch-ownership check entirely for an unrestricted (branchId: null) grant — an owner/manager's grant would let a branch ID belonging to a *different restaurant*, or a nonexistent one, pass through unchecked. Every real call site in the app already re-scopes its own queries by restaurantId independently, so this was **not actually exploitable in practice**, but the primitive itself should guarantee what its name promises. Moved the ownership check to run unconditionally, before the grant is even considered. 2 new tests proving a cross-restaurant and a nonexistent branch ID are both now rejected (404) even for an unrestricted grant.

**P0-2 — QR order idempotency.** The staff order route has always supported `clientRequestId` for safe retries; the public, unauthenticated QR route — the highest-risk one, since it has no staff oversight and runs on the flakiest network conditions — had no equivalent. Added the same field + pre-check + 23505-race-lookup pattern to `src/app/api/order/[token]/route.ts`. 3 new tests exercising the **real route handler** directly (same pattern as the existing eSewa callback test), including a genuine concurrent double-submit that proves only one order is created.

**P0-4 — Push notification branch isolation.** `sendPushToRestaurant()` notified every subscription for the restaurant regardless of which branch the event happened at — a Call Staff tap at Branch A would page a waiter scoped only to Branch B. Added an optional `branchId` param that joins to `userRoles` and only pages subscriptions whose owner is unrestricted or scoped to that branch — the same invariant the SSE realtime path already enforced correctly. Both call sites (order creation, service calls) updated. 3 new tests.

**P0-6 — Timezone re-audit found one real miss.** While re-verifying the earlier timezone fix against this prompt's broader checklist, I found two functions in `src/lib/tables.ts` — `releaseTableIfSoleReservation` and `getTodayUpcomingReservationsByTable` — that Task #130's original pass missed: they computed "today" via the app server's local midnight (`new Date(); setHours(0,0,0,0)`), not the restaurant's timezone. For roughly 5h45m every day this would silently check the wrong calendar day for reservation-release and "today's upcoming reservations" logic. Fixed by threading `timezone` through to `restaurantStartOfDay()`, the same utility every other day-boundary call site now uses. 2 new tests, verified against both pre-fix and post-fix code the same way as the other fixes.

## Deferred, with reasoning (2 of 10)

**P0-9 — Database tenant/branch integrity (composite FKs).** Audited all 8 tables where `branchId` could theoretically belong to a different restaurant than `restaurantId` (`user_roles`, `restaurant_tables`, `orders`, `attendance_records`, `expenses`, `reservations`, `realtime_events`, `service_calls`). **No live exploit found** — every write path already validates in application code, same defense-in-depth pattern as P0-1. Adding real DB-level backstops would mean giving `branches` a `UNIQUE(id, restaurant_id)` constraint and converting all 8 tables' single-column branch FKs to composite `FOREIGN KEY (branch_id, restaurant_id) REFERENCES branches(id, restaurant_id)`. This is exactly the kind of broad, multi-table schema change your own prompt says to stop and explain rather than execute blind. I'd want to inspect production data for constraint violations first (there shouldn't be any, but "shouldn't" isn't "verified") before proposing the actual migration — this is real, valuable follow-up work, just not something to rush into the same pass as the other seven fixes above.

**P0-10 — Next.js dependency security update.** `npm audit` flags a "high" severity `next` entry — traced it to `next`'s own internally-pinned `postcss`/`sharp` versions, not a Next.js core CVE, fixable only via a major 15→16 bump. Checked actual exploitability in *this* app specifically: `next/image` is never used anywhere in the codebase, and `next.config.ts` has no `images.remotePatterns` configured, so the attack surface those CVEs need isn't present here. Your own prompt says not to blindly upgrade unrelated dependencies — a major version bump is real, separately-scoped work (breaking changes, its own regression pass) that doesn't belong bundled into this security pass on my own judgment. Flagging it here rather than either ignoring it or rushing it in.

## Verification (all run for real, this session)

| Check | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 6 warnings (all pre-existing, unrelated to this work) |
| `vitest run` (full suite) | **620/620 passing** (589 baseline + 31 new regression tests) |
| `npm run build` | passing |
| Migrations | `0028_misty_morlocks.sql`, `0029_busy_white_tiger.sql` — both applied cleanly to the dev DB with zero pre-existing constraint violations |

## Files touched

15 modified, 12 new (7 new test files, `safe-redirect.ts` + its test, 2 migration files + their Drizzle snapshots, 1 new route-level test). Net diff: +392/-72 across modified files, plus the new files. Nothing in this pass touches the deliberately-unrebranded session cookie name or IndexedDB names from the earlier rebrand work, and nothing here touches the payment gateway / staff payout code your prompt asked me not to build.

## What I have not done

I have not committed or pushed any of this — same as always, that's your call. I also have not started Phase 2 (P1: CI/CD, E2E tests, error monitoring, security headers, rate limiting, backup/restore) or Phase 3 (P2: cash register, COGS, supplier dues, wastage tracking, stock count, branch transfer, payroll improvements) — those are real, substantial pieces of work in their own right and deserve their own focused pass rather than being rushed in behind this one.
