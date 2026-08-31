# RestroMitra — Platform Control Center + Attendance Overhaul: Final Implementation Report

Response to `PLATFORM_CONTROL_CENTER_IMPLEMENTATION_PLAN.md`'s own closing instruction: *"Final: PLATFORM_CONTROL_CENTER_IMPLEMENTATION_REPORT.md, same format as this engagement's other final reports — what shipped, what's tested, what's deliberately deferred, honest score."* This report covers the full 17-phase plan, both tracks, built phase by phase across many sessions, each phase verified (tsc/lint/vitest/build) and committed locally before the next began.

```text
Baseline commit: 84d9482  (repo state before this plan's Phase 1 began)
Final commit:    0aff5e9
Commits in pass: 18  (11 Track A + 7 Track B — Phase 16 split into two commits)
Tests:           1241 passing (157 files) — up from 985 (125 files) at baseline
TypeScript:      clean (npx tsc --noEmit, exit 0)
Lint:            clean (0 errors, 6 pre-existing warnings, none in any phase's files)
Build:           clean (npm run build, exit 0)
npm audit:       postcss (via next's bundled dependency, needs Next 16) and esbuild
                 (via drizzle-kit, dev-server-only) remain — unchanged from the prior
                 report, deliberately not force-upgraded (see §8)
E2E:             not re-run this pass — carried forward as a disclosed gap (see §8)
```

All commits in this pass stayed **local-only**, per this engagement's standing instruction: nothing was pushed to the `origin` remote unless a live chat message explicitly asked for it, and none did.

## 1. What shipped — Track A: Platform Control Center

Eleven phases building a second admin product: a SaaS-owner control panel, separate from every restaurant's own dashboard, for running RestroMitra as a business rather than as a restaurant.

1. **Platform authorization realm** (`cacce27`) — four new platform-scoped roles (super_admin, support_admin, billing_admin, platform_viewer) alongside the pre-existing platform_admin; a `PLATFORM_PERMISSIONS` catalog and `requirePlatformPermission()` mirroring the existing tenant RBAC pattern; a real grant/revoke UI and API for platform roles (previously only possible via raw SQL, with no audit trail); a hard MFA requirement enforced at the point of platform access, plus a reachable `/admin/account` page so a platform-only user can actually turn MFA on. Guardrails: only platform_admin/super_admin can grant platform roles, and revoking the last full-access holder is blocked.
2. **Tenant management** (`1fecb0d`) — reversible, data-preserving suspend/reactivate, enforced at both the API layer (`resolveRestaurantContext`) and the dashboard layer (redirect to `/suspended`), independent of billing status. Migrated the three pre-existing admin restaurant routes off the coarse `requirePlatformAdmin()` onto Phase 1's fine-grained permissions, so the new narrower roles could actually use the admin shell they were granted.
3. **Subscription state machine** (`3d3c593`) — a new "paused" status (reversible, admin-initiated, distinct in intent from cancelled though sharing its access math) plus shorten-trial and a "convert trial to plan" UI. Deliberately did **not** add a separate "grace_period" status: `computeSubscriptionAccess`'s existing comment already documents past_due as the grace period, and a second status meaning the same thing would be a confusing synonym rather than a real addition — a scoped deviation from the plan's original wording, disclosed rather than silently done.
4. **Data-driven plan catalog** (`a4fd2f6`) — converted plans from a hardcoded 3-entry array and a fixed Postgres enum into a real `plans` table, so a platform admin can add, retire, or reprice a plan from `/admin/plans` without a code change. Introduced the `feature-catalog.ts` `FEATURES` keys (distinct from a plan's free-text marketing copy) that Phase 5 gates on. Every call site that read the old static plan list was migrated to the async DB-backed versions.
5. **Entitlement engine** (`e44d80d`) — the core mechanism the rest of the platform build depends on: `resolveFeatureAccess()` resolves override → plan → flag → none, with an explicit `override:false` distinguished from "no override at all." New `feature_flags` (global rollout/kill-switch defaults) and `entitlement_overrides` (per-tenant forced grant/deny, audited) tables, plus an "explain this tenant's access" debug screen on the admin restaurant detail page.
6. **Platform audit log viewer** (`222764a`) — `listPlatformAuditLogs()`, the cross-tenant counterpart to the tenant-scoped `listAuditLogs()`, closing the read gap on platform-scoped audit rows that had been written since Phase 1 with no way to see them.
7. **AI Provider Control Center** (`e1df036`) — encrypted (AES-256-GCM) DB-backed AI provider configuration with automatic failover, per-call usage/cost estimation, and per-tenant monthly request limits enforced through the Phase 5 entitlement engine. **Disclosed behavior change**: the AI assistant became gated behind the `ai_assistant` feature key for the first time — Starter-plan restaurants now see "not included in your plan" where every restaurant previously had unrestricted access. This was the approved scope of the phase, not an incidental side effect.
8. **Impersonation** (`837ea81`) — a dedicated, additive session (own table, own opaque cookie, 30-minute server-enforced lifetime, DB-level one-active-session-per-admin constraint) so a platform admin can view or, with a separate write grant, act inside a tenant's dashboard for support. A persistent, un-dismissable banner names the target, reason, and expiry. Every audit log entry recorded during an active impersonation is auto-tagged, without touching any of the ~150 pre-existing `recordAuditLog()` call sites.
9. **Support tooling** (`7cee903`) — global search extended to match an owner's name/phone (not just the restaurant's own name/slug), internal notes, a fixed-catalog support-status tag system (vip/at_risk/churn_risk/escalated/needs_follow_up/new), forced session revocation for a single staff member, and a deliberately simple, itemized, always-explainable tenant health score that only ever subtracts from 100 with a named reason per deduction.
10. **Announcements, system health, maintenance mode, break-glass** (`4baaa70`) — platform-wide dismissible announcements; an `/admin/system` page surfacing DB reachability/latency, subscription-status counts, and recent signups; a genuine Postgres singleton table for maintenance mode (its own type makes a second row impossible) that blocks all tenant-facing access except platform admins and active impersonation sessions — which is itself the disclosed break-glass path, made traceable via a `duringMaintenanceMode` audit tag.
11. **Security test pass** (`08d552f`) — a dedicated audit of six areas (platform isolation, override isolation, expired-tenant premium-endpoint denial, plan-limit enforcement, impersonation authorization, audit completeness) found and fixed a real TOCTOU race (two concurrent requests could both pass a staff/branch plan-limit count-check before either insert committed, letting a restaurant exceed its plan by one seat), closed with a `SELECT...FOR UPDATE` row lock, plus new regression tests for cross-tenant entitlement-override isolation and expired-tenant defense-in-depth. **Two findings from that same audit were left open, disclosed rather than silently dropped** — see §8.

## 2. What shipped — Track B: Attendance overhaul

Six phases (Phase 16 split across two commits) replacing a bare clock-in/clock-out timestamp pair with selfie-verified attendance, a real status/review workflow, leave and holidays, scheduling, analytics, payroll integration, and plan gating.

12. **Object storage + selfie-verified clock-in/out** (`61cdf90`) — a genuinely new object-storage subsystem (`src/lib/storage/`) supporting any S3-compatible provider via presigned URLs; photos never pass through the app server, only through direct browser-to-bucket PUTs and short-lived signed GETs. A Nepal Individual Privacy Act, 2075 (2018)-informed consent notice (researched via web search, not assumed) gates selfie capture behind an append-only consent ledger. An owner-controlled `selfieClockInRequired` toggle defaults off, so every existing restaurant is unaffected until an owner opts in. Tested against `s3rver`, a real in-process S3-compatible server, not a mock of the storage code's own logic.
13. **Attendance status model + review workflow** (`cbd24ea`) — every attendance record now carries `verified` / `needs_review` / `rejected`, auto-set on clock-in/out (a record only ever reaches `needs_review` when it has unreviewed photo evidence). Two orthogonal manager actions, kept as separate routes and separate ledgers: a status-review PATCH (verify/reject a shift's photo evidence) and a general correction PATCH (fix a mistaken time, always with a reason, written to an append-only `attendance_corrections` ledger in the same transaction as the update).
14. **Leave requests and holidays** (`ecdfc8b`) — self-service leave requests (sick/casual/unpaid/other) with owner/manager approve/reject, overlap-checked against the requester's own pending/approved dates; a restaurant-declared holidays list (branch-specific or restaurant-wide). Deliberately does not track leave balance/accrual this phase — request → review → record only.
15. **Staff scheduling vs. actual attendance** (`0780a34`) — a manager-planned weekly schedule matched at *read time* (not a stored foreign key, so a later attendance correction can never leave a stale link) against real clock-in/out to surface late arrivals, early departures, and no-shows, with a 5-minute grace period before a variance counts.
16. **Attendance analytics + payroll integration** (`92bc906` + `0598b27`) — payroll now excludes rejected attendance records from paid time (unverified photo evidence shouldn't count toward pay) and folds approved, non-unpaid leave days into a "daily" salary's owed amount (hourly/monthly deliberately left unprorated — no invented policy for either). A new per-employee and aggregate attendance analytics module and dashboard panel reuse the same underlying computations rather than recomputing them a second time.
17. **Plan-gated attendance tiers** (`0aff5e9`) — wires the Phase 5 entitlement engine into attendance. Gates the advanced suite built in Phases 12-16 (photo verification/review, leave/holidays, scheduling, analytics) behind a new `staff_attendance` feature key on Growth and Pro plans; leaves plain clock-in/clock-out (which every existing restaurant already uses, free-tier or not) permanently ungated, since retroactively paywalling it was judged out of scope. This gating scope, and which plan tiers should carry the key, was a genuine pricing/customer-impact decision the plan document itself didn't specify — resolved by asking the user directly rather than picking a default silently; the user chose "advanced suite only" and "Growth + Pro," both of which shaped the implementation.

## 3. Cross-cutting architecture

A few decisions recur across both tracks and are worth naming once rather than per-phase:

- **`resolveRestaurantContext()` as the single choke point.** Every tenant-scoped API route resolves auth, restaurant-by-slug, suspension, active subscription, maintenance mode, an optional permission check, and — as of Phase 17 — an optional feature-entitlement check, all through one function, all short-circuited by `HttpError` subclasses that a single `toErrorResponse()` converts to the right status code. Phase 17 needed to gate roughly a dozen routes at once; adding one `opts.requireFeature` field here scaled far better than a hand-rolled try/catch per route (the kind the older, pre-existing `AiAssistantNotEntitledError` needed before this pattern existed).
- **`isPlatformOrImpersonatedRole()` as the uniform bypass.** Suspension, subscription, maintenance-mode, and feature-gating checks all skip for platform admins and active impersonation sessions using the same check, so support/ops staff always see the same capabilities a tenant has, regardless of that tenant's plan or state.
- **Ledger over mutable flag, applied consistently.** Attendance corrections, attendance photo consent, and platform audit logs are all append-only tables recording history, rather than a single row that gets overwritten — the same shape this codebase already used for payments and stock movements before this engagement began.
- **Pure module + `*-db.ts` split, applied to every new subsystem.** Plans, entitlements, attendance analytics, and AI provider config all separate dependency-free logic (unit-testable with no database) from the `server-only`, DB-backed function that calls it — the same split the pre-existing subscription module used as precedent.
- **No invented policy.** Where the plan or the domain left a rule genuinely unspecified — how many hours a paid leave day is "worth" for an hourly worker, what Nepal's Privacy Act mandates for photo retention, what PF/SSF/TDS deductions should be — this build consistently declined to guess, either leaving the case unhandled with a disclosed comment or building a configurable field instead of a hardcoded rule.

## 4. Database changes

Thirteen new migrations, `0054` through `0066`, all additive (no destructive schema change to any pre-existing column):

| Migration | Phase | What it added |
|---|---|---|
| 0054 | 1 | Platform role enum values, platform permission grants |
| 0055 | 3 | `paused` subscription status |
| 0056 | 4 | `plans` table (seeded from the prior hardcoded catalog), FK from `restaurants.plan_key` |
| 0057 | 5 | `feature_flags`, `entitlement_overrides` |
| 0058 | 7 | `ai_provider_configs`, `ai_usage_logs`, `aiMonthlyRequestLimit` columns |
| 0059 | 8 | `platform_impersonation_sessions` (+ partial unique index) |
| 0060 | 9 | `restaurant_support_notes`, `restaurant_support_tags` |
| 0061 | 10 | `platform_announcements`, `platform_maintenance_mode` singleton |
| 0062 | 12 | `selfieClockInRequired`, photo object-key columns, `attendance_photo_consents` |
| 0063 | 13 | Attendance `status` column, `attendance_corrections` ledger |
| 0064 | 14 | `leave_requests`, `holidays` |
| 0065 | 15 | `scheduled_shifts` |
| 0066 | 17 | Data-only: adds `staff_attendance` to Growth/Pro `feature_keys` |

Phases 2, 6, 11, and 16 needed no schema changes — they built on tables and columns already in place by the time they ran. Every migration was applied to the local dev database and spot-checked (via `psql` or the relevant DB-integration test) before its phase was considered complete.

## 5. API changes

Every new endpoint across both tracks is additive — no pre-existing endpoint's request or response contract was broken. The volume is large enough that this report doesn't re-list every route (each phase's commit message above enumerates its own); the notable pattern is that **Phase 17 changed no endpoint's shape at all** — it only added an optional, backward-compatible gate in front of routes that already existed, so no client code written against the pre-Phase-17 API needed to change for tenants who remain entitled.

## 6. UI changes

- A full second admin product under `/admin`: tenant list/detail/suspend, plans CRUD, feature flags, entitlement explain/override, platform audit log, AI provider config + usage dashboard, impersonation controls + active-session panel, support notes/tags/health score, announcements CRUD, system health, maintenance-mode toggle.
- `/dashboard/staff` gained an Attendance status/review workflow (badges, a "needs review" filter, a review modal with captured photos), a Leave tab, a Schedule tab, a collapsible attendance analytics panel, and payroll's roster/pay-modal views now show paid-leave-day detail alongside worked time.
- A persistent impersonation banner and a maintenance-mode redirect page apply globally across every `/dashboard/*` page.
- A `SelfieClockModal` walks staff through consent, camera preview, capture, and upload at clock-in/out when a restaurant has the toggle on; restaurants that leave it off see no UI change at all.

## 7. Tests and verification

Re-run fresh at the current HEAD (`0aff5e9`) as part of writing this report, not merely carried forward from each phase's own commit message:

- `npx vitest run`: **1241 passed, 0 failed, 157 test files** — up from 985/125 at this plan's baseline (`84d9482`), an increase of 256 tests across the 18 commits in this pass.
- `npx tsc --noEmit`: clean, exit 0.
- `npm run lint`: 0 errors; 6 pre-existing warnings, all outside every phase's own files (two unused `eslint-disable` directives, one `<img>` LCP hint, one unused variable in a payout-methods helper, two in one-off smoke-test scripts) — identical to the warning set the prior `FINAL_10_10_COMMERCIAL_COMPLETION_REPORT.md` already disclosed, unchanged by this entire 17-phase build.
- `npm run build`: clean, exit 0.
- `npm audit`: unchanged from the prior report — `postcss` (via `next`'s own bundled dependency) and `esbuild` (via `drizzle-kit`, dev-server-only) both still require a breaking major-version bump to auto-fix and were not forced in this pass, for the same reason the prior report deferred them.
- Every new subsystem that touches a real backend was tested against that real backend, not a mock of its own code: Postgres for every DB-integration test, and a real in-process S3-compatible server (`s3rver`, devDependency only) for the object-storage subsystem's presigned-URL round trip.
- **E2E (Playwright)** was not re-run in this pass. The prior commercial-readiness report already documented that this sandbox's Chromium launch is unreliable (OOM-killed) and that the suite runs for real in `ci.yml` on every push; nothing in this pass's changes touches any of the four E2E-covered flows (owner login, QR ordering, reservations, staff order management) directly, but this was not independently re-confirmed here either — carried forward as a disclosed gap, not silently dropped.

## 8. Remaining limitations (deliberately deferred, not hidden)

Compiled from every phase's own disclosed scope decision, plus one additional cross-cutting gap verified directly against the current code while preparing this report:

- **A significant, verified, cross-cutting access gap**: `src/app/dashboard/staff/page.tsx` redirects any user away from the entire staff page — Roster, Attendance, Leave, Schedule, and Payroll tabs alike — unless they hold `MANAGE_STAFF`, `VIEW_PAYROLL`, or `MANAGE_PAYROLL`. This means an ordinary line-staff member has **no path to self-service clock-in/clock-out** (or any attendance feature, free or plan-gated) through this UI at all today. This was flagged as a known gap as far back as Phase 14's own commit message ("a genuine line-staff self-service leave/attendance surface needs a broader access decision this phase doesn't make") and confirmed by directly reading the page's current source while writing this report — it is real, still open, and affects the *free* basic attendance tier just as much as the Phase 17-gated advanced one.
- **No session-mocking test harness**, a structural limitation of this codebase, not of any one phase: anything depending on `cookies()` (`resolveRestaurantContext`, `requireAuth`, `getImpersonationContext`, `startImpersonation`) cannot be exercised end-to-end by an automated test here. Every phase compensates by testing the exact DB-level shape/transaction/query a route relies on directly against real Postgres, but route-handler-level behavior (the actual HTTP request/response cycle, including cookie handling) is not covered by this test suite for any route that touches session state — this spans impersonation, attendance corrections, leave, scheduling, and all of Phase 17's route-level gating.
- **Phase 3**: no separate `grace_period` subscription status — `past_due` already serves that purpose; a deliberate deviation from the plan's literal wording, not an oversight.
- **Phase 7**: the AI assistant's gating behind `ai_assistant` is a real, disclosed behavior change for existing Starter-plan restaurants (previously unrestricted, now blocked) — intentional per the approved scope, but worth remembering if a support ticket references it.
- **Phase 8 (Impersonation)**: test coverage is a security-property-focused subset (no-nested-impersonation under real concurrency, cascade delete, revoke semantics, the pure read-only/permission helpers) rather than a full end-to-end test with a real impersonation cookie — blocked by the no-session-mocking-harness limitation above.
- **Phase 9/10**: the tenant health score and the `/admin/system` health page are both deliberately simple, itemized, human-readable signals (named deductions; DB reachability/latency; counts) — not a full observability stack or black-box scoring model. This is a scope choice appropriate to a single-instance deployment, not an oversight.
- **Phase 11 — two findings from its own security audit remain open, not silently dropped**: (1) `isPlatformAdmin()`'s bypass inside `requireRestaurantAccess` has no MFA check, unlike `requirePlatformAdmin`/`requirePlatformPermission`, and grants blanket cross-tenant access outside impersonation's audit trail — a genuine hardening candidate, deferred because changing it touches a load-bearing bypass an existing regression test already depends on; (2) no end-to-end impersonation test exists with a real cookie, and audit-call-site completeness (that every one of the ~150 `recordAuditLog()` call sites actually gets the impersonation tag applied at runtime) is unverified beyond code inspection — both blocked by the same test-harness limitation.
- **Phase 12**: per-record manual photo deletion was never built (only time-based retention purge exists); the verification review UI it originally deferred was built in Phase 13 as planned.
- **Phase 13**: no support for reopening a closed shift (clearing a clock-out back to null) — a manager must use the correction PATCH with a reason instead.
- **Phase 14**: no leave balance or accrual tracking — requests are approved/rejected and recorded, but nothing counts down a yearly allowance.
- **Phase 15**: overnight shifts (end time past midnight) aren't supported — a manager schedules them as two separate shift-date rows; `pairShiftsWithAttendance`'s positional-zip matching is a known, disclosed limitation for a genuine split-shift day (more than one shift and more than one attendance record for the same person on the same day).
- **Phase 16**: the printed payslip snapshot does not record `paidLeaveDays` — it would need its own schema migration, out of this phase's scoped plan; a payslip for a period containing paid leave won't show that detail even though the underlying pay calculation already accounts for it correctly.
- **Phase 17**: no client-side entitlement pre-check exists — the Leave/Schedule/Analytics tabs stay visible to every restaurant regardless of plan, and a non-entitled tenant only learns it isn't included when a request fails with a clear error banner. This mirrors the pre-existing AI-assistant precedent exactly; it's a rough edge, not a bug.
- **Nepal statutory payroll (PF/SSF/TDS)** remains explicitly out of scope across this entire engagement, as it has been since the prior commercial-readiness report — the payroll and payslip system supports manually-entered, configurable figures rather than inventing tax rules this codebase has no authority to get right.
- **`postcss`/`esbuild` npm audit findings** and the **not-independently-re-confirmed E2E suite** are both carried forward unchanged from `FINAL_10_10_COMMERCIAL_COMPLETION_REPORT.md` — see §7.

## 9. Commercial readiness

Both tracks of the plan are **feature-complete and independently tested at every phase boundary**. Track A gives RestroMitra a genuine second admin product for running the business side of the SaaS — tenant lifecycle, plans, entitlements, AI cost control, impersonation, support tooling, and platform-wide operational controls — none of which existed at any level before this engagement. Track B replaces a bare clock-in/clock-out pair with a real attendance system: photo verification, a review workflow, leave and holidays, scheduling with variance detection, analytics, payroll integration, and plan-based monetization of the advanced tier.

The one item in §8 that most affects near-term usability is the `/dashboard/staff` page-level access gate: as shipped, only owner/manager-tier roles can reach *any* attendance feature, including the free clock-in/clock-out every existing restaurant already relies on. If self-service attendance for ordinary line staff is a near-term priority, that access decision — not anything built in Phases 12-17 — is the next thing to resolve, and it was intentionally left as a decision rather than guessed at, since it changes who can see what inside a restaurant's own staff data.

## 10. Final score: 9.5/10

Not a 10, for three honest reasons, none of them a regression introduced by this pass: the `/dashboard/staff` access gate blocking ordinary staff from even the free attendance tier is a real, verified, user-facing limitation, not a documentation footnote; two structural gaps from Phase 11's own security audit remain open by deliberate choice rather than being fixed; and the E2E suite, the `postcss`/`esbuild` dependency findings, and the no-session-mocking-harness limitation are all carried forward rather than newly resolved. It's a 9.5, not lower, because every one of those gaps was found by this engagement's own verification process and disclosed here in detail rather than glossed over, every phase's own scoped work was actually tested against a real database (and, where relevant, a real S3-compatible server) rather than described as tested, the full regression suite grew from 985 to 1241 passing tests with zero failures across 18 commits, and TypeScript, lint, and a production build all ran clean at the final commit — covering all 17 phases of both tracks simultaneously, not just the code any single phase touched.
