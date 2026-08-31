# RestroMitra — Master Gap Audit

Response to the founder's 90-section production-readiness master prompt. Per the founder's own instruction to audit before implementing, this document is **audit-only** — six independent, read-only research passes inspected the actual current source code (not prior reports' claims) against every checklist item in the prompt. Nothing in this document has been implemented yet; it exists so the real gaps can be scoped into verified phases, the same way the prior 17-phase engagement worked, rather than attempting all 90 sections unscoped in one pass.

```text
Audit method:    6 parallel research agents, evidence-based (file paths / line
                 numbers / schema columns / test names cited per finding),
                 independently skeptical of prior reports and of each other
Scope:           All 90 sections of the founder's master prompt
Baseline commit: 8940b59 (current HEAD, unchanged — no code was touched)
Overall finding: The prior 17-phase engagement already built most of what
                 this prompt asks for. Genuine gaps are real but bounded —
                 mostly config/wiring/testing/docs, not missing architecture.
```

## How to read this document

Each finding is tagged **ALREADY BUILT**, **PARTIAL**, or **MISSING**, with a priority for anything not already built: **P0** (security/data-loss/tenant-isolation/production-blocker), **P1** (important commercial), **P2** (competitive enhancement), **P3** (future/advanced) — the founder's own priority scale. Findings are grouped by the six audit clusters; each cluster maps to specific sections of the master prompt.

## 1. Security & access control (§1-3, 35-40, 79)

**Solid, evidence-confirmed foundations**: tenant isolation (every route resolves `restaurantId` server-side via `resolveRestaurantContext`, never a client-supplied value — spot-checked orders, payroll, expenses, staff, inventory routes), RBAC (every sensitive action — refunds, payroll, inventory adjustment, staff management, platform admin, impersonation — checked server-side, not UI-only), open-redirect protection (`safe-redirect.ts` is an allow-list, not a block-list, and explicitly defeats `https://`, `//`, `/\`, `javascript:`), session security (password reset revokes all sessions, password change revokes all *other* sessions, a standalone "logout everywhere else" endpoint exists), security headers (a real, tested CSP with `object-src 'none'`, `frame-ancestors 'none'`, HSTS, `X-Frame-Options: DENY`, `Permissions-Policy` locking down camera/mic/geo — with a documented, deliberate `'unsafe-inline'` gap), money handling (integer paisa throughout, no float arithmetic), and platform-admin route protection (every `/api/admin/*` route requires `requirePlatformAdmin`/`requirePlatformPermission`, which enforce MFA).

**Gaps found:**

- **Rate limiting is in-memory/single-instance** (`src/lib/rate-limit.ts`'s own comment admits this) — every counter resets on restart and doesn't share state across multiple Node processes. This is a genuine production blocker the moment the app runs behind a load balancer with more than one instance. **P0.**
- **Branch security has no database-level backstop.** The application layer correctly validates a requested `branchId` belongs to the requested `restaurantId` (`requireBranchAccess` in `guard.ts`), but nothing at the schema level (no composite FK/constraint) would catch a bug that skipped that check — `orders`, for instance, has independent single-column FKs to `restaurants` and `branches` with no cross-constraint. Not currently exploitable per the code's own audit trail, but a real defense-in-depth gap. **P1.**
- **MFA is not enforced for restaurant owners**, only for platform admins. The infrastructure (TOTP, backup codes, enrollment flow) is fully built and available as self-service opt-in to any user — it's just not mandatory for the role (owner) that controls a restaurant's financial data. **P1.**
- **DB CHECK constraints don't cap percentage fields.** `tax_rate_basis_points` and `service_charge_basis_points` have no constraint capping them at 10000 (100%) — every other amount/quantity field in the 50+ constraint set does have a floor, this one pair is missing a ceiling. **P2.**
- General platform-admin list/read endpoints (tenant listing, plan catalog, entitlements, audit-log reads) have no rate limiting of their own — lower severity since they require an already-authenticated, MFA'd session. **P2.**

## 2. Platform admin & SaaS business layer (§4-14, 71-75)

**Solid, evidence-confirmed foundations**: the entitlement engine (override > plan > flag > none, correctly distinguishing an explicit `false` override from no override at all), impersonation (mandatory reason, 30-minute server-enforced expiry, separate cookie, full audit tagging, visible banner — essentially complete against the master prompt's own checklist), the platform audit log (broad coverage across login, registration, MFA, staff, restaurants, subscriptions, AI config, entitlements, impersonation), non-destructive subscription expiry (view/login/export/renew stay available, no automatic data deletion, all enforced server-side), and AI tenant isolation (every AI call scoped to one restaurant, per-tenant monthly quota, failover chain).

**Gaps found:**

- **The platform dashboard is missing the commercial metrics the founder specifically asked for**: total/active users, active branches, orders today/this month, revenue metrics, subscription revenue, plan distribution, feature-usage counts, and a recent-activity feed. What exists today (restaurant counts by subscription status, signups in 24h, DB health) is real but narrow. **P1.**
- **The restaurant detail page is missing branches, a real active-sessions list (today it's a blind "revoke" with no visibility into what's being revoked), recent orders, and restaurant-scoped audit events** — all data that already exists elsewhere in the system, just not surfaced on this one screen. **P1.**
- **No proactive platform alerting.** A per-tenant health score exists, but only as something an admin looks up one restaurant at a time — there's no platform-wide "these 12 tenants are at risk" list, and no alerting at all for AI provider failures or system errors. **P1.**
- **No restaurant-owner-facing support ticket system.** The only support mechanism today is admin-authored internal notes — a tenant has no way to submit an issue from their own dashboard. **P1.**
- **Entitlement overrides can't expire.** The schema has no `expiresAt` column — a temporary grant (e.g., "unlock advanced AI until Dec 31") requires manually remembering to revoke it later. **P2.**
- **No custom per-restaurant plan builder.** Every restaurant is on one of the shared catalog plans (Starter/Growth/Pro); the only per-restaurant customization is price grandfathering, not a bespoke feature/limit set. **P2.**
- **The AI provider abstraction is two hardcoded functions, not a real adapter pattern.** Adding OpenAI or Gemini support today means new schema enum values and new code branches in at least two files, not a config change — the architecture the master prompt asks for (a genuine `ProviderAdapter` interface) doesn't exist yet. **P2.**
- **No AI request-level limits**: token cap is hardcoded (512), and there's no timeout, retry policy, or per-request rate limit. **P2.**
- **No feature-usage analytics** ("how many restaurants use POS/inventory/payroll/AI") anywhere in the admin console. **P2.**
- The platform health dashboard covers DB reachability/latency only — no realtime, push, AI-provider, or email service status. **P2.**

## 3. Attendance, payroll, cash register & EOD (§15-22)

**Solid, evidence-confirmed foundations**: attendance photo privacy (short-lived signed URLs only, never public, platform admin has no route to browse individual photos), staff scheduling (a day with no scheduled shift is correctly never flagged absent), the cash register subsystem (opening/closing, cash movements, expected-vs-actual variance, immutable post-close corrections requiring a reason — genuinely complete against the checklist), end-of-day closing (full payment-method breakdown, business-day locking via an elevated permission requirement rather than a blunt read-only freeze), and an honest, explicit no-statutory-tax disclaimer printed directly on every payslip.

**Gaps found:**

- **Holidays and approved leave are never cross-referenced against no-show/lateness calculations** — this is a real correctness bug, not just a missing feature. A staff member on approved leave, or at a branch with a declared holiday, who therefore doesn't clock in, is currently counted as a no-show/late statistic in attendance analytics at the same time they're correctly counted as being on paid leave. This doesn't affect payroll pay (that calculation is separate and correct) but it does corrupt manager-facing attendance reports. **P1.**
- **No separate "workplace photo"** distinct from the staff's own selfie — only one photo capture exists per clock-in/out event. **P2.**
- **No persisted daily attendance-classification status** (late/absent/half-day/holiday as a queryable field) — "late"/"no-show" exist only as an ephemeral, computed value at read time, not a stored, reportable attendance-record status. **P2.**
- **No overtime, bonus, or advance automation in payroll** — base pay (monthly/daily/hourly) is correctly computed, but overtime and bonuses don't exist as computed concepts; the only workaround is manually typing a labeled deduction/addition line per payout. **P2.**

## 4. Inventory & finance (§23-29, 58-59)

**Solid, evidence-confirmed foundations**: inventory costing race conditions (genuinely tested under real concurrent Postgres transactions with row locking, not a shortcut), wastage tracking (full reason taxonomy, cost snapshots, rolled into reporting), physical stock count (variance thresholds routing large discrepancies to a separate approval permission — real segregation of duties), multi-branch stock transfer (tenant isolation confirmed at creation — both branches must belong to the same restaurant, can't create a cross-tenant transfer), COGS reporting (correctly flags when cost coverage is partial rather than silently understating it), and honest labeling everywhere the codebase touches a claim it can't back up (Account Books is called exactly that, never "accounting" or "double-entry"; Nepal compliance is explicitly disclaimed as unverified in both the README and the onboarding UI).

**Gaps found:**

- **No supplier statement view.** What exists is a point-in-time outstanding-due report; there's no running ledger (opening balance + purchases + payments + adjustments = closing balance) a supplier relationship would actually need. **P1.**
- **Recipe costing only exists at the base menu-item level** — a variant (small vs. large) uses the identical recipe as its base item with no quantity scaling, and addons have zero linkage to inventory or cost at all. This means the COGS/margin figures the system otherwise computes carefully are understated whenever variants or addons meaningfully consume ingredients. **P1.**
- Negative stock is always allowed by deliberate, disclosed design, with no restaurant-level toggle to disallow it for restaurants that want hard stock enforcement. **P2.**
- No PAN/VAT display on printed bills and no fiscal invoice sequencing separate from the internal order number — a real functional gap, though the code correctly never claims otherwise. **P2.**

## 5. Ordering, POS, realtime & core ops (§30-34, 45-57)

**Solid, evidence-confirmed foundations**: order idempotency (a DB-level unique constraint on `clientRequestId`, tested under real collision), call-staff concurrency (a partial unique index proven under real concurrent inserts), push notification branch scoping (tested — Branch B never sees Branch A's events), realtime SSE (branch/tenant filtering applied in SQL before results are returned, tested against a 205-event noise scenario), timezone handling (a dedicated restaurant-timezone module used consistently, with a regression test proving a prior server-local-midnight bug was fixed), QR security (256-bit token entropy, regeneration proven to invalidate the old token), and essentially the entire POS/KDS/reservations/table-management/combos/customer-credit/loyalty/website-builder/printing feature set, each independently verified against the checklist with real tests rather than assumed from a commit message.

**Gaps found:**

- **Coupons are missing per-customer usage limits, branch restrictions, menu/category restrictions, and first-order-only conditions.** What's built (percentage/flat discount, minimum order, date range, global usage cap) is race-safe and correct, but the missing per-customer check is a concrete revenue-leakage risk — nothing stops one customer from redeeming a "first order" coupon repeatedly today. **P1.**
- A 5-second polling backstop still runs alongside SSE on Orders/KDS/Dashboard views — documented as a deliberate reconciliation fallback, not blind duplication, but worth revisiting once SSE reliability is trusted. **P2.**
- No test explicitly proves KDS branch-visibility (the underlying shared authorization pattern strongly implies it's already enforced, just not directly tested by name). **P2.**
- Loyalty point double-award protection relies on a single call site's transaction guarantee with no database-level backstop (no unique index on the transaction reference). **P2.**
- No custom-domain architecture for the website builder — sites are served only at `{app}/{slug}`. **P2.**
- No end-user documentation for physical thermal-printer setup, despite the underlying ESC/POS implementation being solid. **P2.**

## 6. Platform engineering quality (§41-44, 60-70, 76-78)

**Solid, evidence-confirmed foundations**: password/account recovery (hashed reset tokens, single-use, proper invalidation), environment/secrets hygiene (`.gitignore` correctly excludes `.env*`, no real secrets in `.env.example`), a genuinely tested backup/restore process (a real `pg_dump`/`pg_restore` run against a populated dev database, not just aspirational documentation), a CI pipeline that actually runs lint/typecheck/tests/build against a real Postgres service container on every push, migration practice (67 migrations, only 3 contain any `DROP` and each is a safe backfill-then-drop pattern), mobile/tablet responsiveness including graceful camera-permission failure handling in the selfie clock-in flow, and — notably — **zero false feature claims found anywhere** in the README or marketing copy; every compliance-adjacent claim is explicitly and correctly hedged.

**Gaps found:**

- **No Privacy Policy, Terms of Service, or data-retention/account-deletion policy exists anywhere in the repository**, despite the app collecting customer PII, staff data, attendance selfies, and financial records. This is a real legal/compliance exposure, not a code quality issue. **P0.**
- **Error monitoring code is fully built but inert by default** — Sentry wiring and PII redaction are both correct and tested, but nothing reports anywhere until a `SENTRY_DSN` is actually configured in production. **P0** (must be turned on before launch, not a code gap).
- **Zero end-to-end test coverage for platform-admin and impersonation flows** — the only 4 E2E specs that exist cover owner login, QR ordering, reservations, and staff order management. The most privileged, most security-sensitive part of the entire system (admin login → dashboard → restaurant → plan → feature override → impersonation → exit) has no automated end-to-end proof at all. **P0.**
- The CI pipeline's deploy gate exists in code but is switched off (`DEPLOY_ENABLED` not set) — deployment today is still a manual SSH process. **P1.**
- The restaurant-facing audit log UI's backend supports date-range/user/branch/resource filters, but the UI itself only exposes a single free-text filter; impersonation events are logged correctly but render as a raw JSON blob rather than a readable sentence. **P1.**
- Data export is missing entirely for orders, purchases, attendance, and payroll (customers/inventory/ledger/suppliers/staff roster are covered); no Excel or PDF export exists anywhere except one payslip print view. **P1** (missing entities), **P2** (formats).
- Backup process is tested and documented but not automated/scheduled — it's a manual command today. **P1.**
- Broader E2E and chaos-testing coverage (owner onboarding, KDS, inventory→recipe→deduction, attendance-with-selfie, payroll, multi-branch cross-access denial, offline sync, network-timeout/expired-session/SSE-reconnect/push-failure/email-failure/AI-provider-failure scenarios) doesn't exist yet — the duplicate-request/race-condition class of chaos testing is genuinely excellent (a dozen dedicated concurrency tests against real Postgres), but external-service-failure testing is essentially unstarted. **P1.**
- No `SECURITY.md` file exists — security posture is documented only as inline README notes. **P1.**
- Minor: a `s3rver` dev-only test dependency carries transitive vulnerabilities (dev-only blast radius, never shipped); `MIGRATION_SAFETY.md`'s claim that every migration has been additive is technically inaccurate (3 migrations do contain a `DROP`, though none unsafely); a couple of admin panels weren't confirmed to have loading/empty states; Orders/POS still use a raw browser `confirm()` dialog rather than a styled modal for cancel/void. **P2.**

## Priority rollup

**P0 — do these before calling anything production-ready:**
1. Rate limiting needs a shared store (Redis/Upstash) before running more than one instance.
2. Write and publish a Privacy Policy, Terms of Service, and data-retention/account-deletion policy.
3. Configure `SENTRY_DSN` in production (the code is already correct and tested).
4. Build end-to-end test coverage for the platform-admin and impersonation flows.

**P1 — important commercial gaps**, roughly in order of founder-facing impact: branch/restaurant DB-level composite constraint; MFA enforcement for owners; platform dashboard revenue/usage/plan-distribution metrics; restaurant detail page completeness (branches, sessions, orders, audit events); proactive platform alerting; restaurant-owner support tickets; holiday/leave miscounting attendance-analytics bug; supplier statement view; variant/addon recipe costing; coupon per-customer/branch/category restrictions; audit-log UI filters + readable impersonation entries; missing export entities (orders/purchases/attendance/payroll); backup automation; CI deploy-gate activation; broader E2E/chaos coverage; `SECURITY.md`.

**P2 — competitive enhancements**: tax-basis-point CHECK constraint; admin endpoint rate limiting; entitlement override expiry; custom per-restaurant plans; real AI provider adapter abstraction; AI request limits/timeout/retry; feature-usage analytics; fuller platform health dashboard; workplace photo; persisted daily attendance status; payroll overtime/bonus automation; negative-stock toggle; PAN/VAT on printed bills; realtime polling backstop; loyalty DB-level double-award backstop; custom domains; printer setup docs; export formats (Excel/PDF); dev-dependency vulnerability cleanup; UI polish.

**P3 — future/advanced**: subscription state-machine naming granularity (behavior is already safe); QR disable-without-regenerate toggle; deeper performance audit beyond the spot-check already done.

## Current-state scores

These reflect what the audit actually found, not a target — they will move once the P0/P1 list above is worked through.

```text
SECURITY:              7.5/10   Strong isolation/RBAC/session/header foundations;
                                 in-memory rate limiter and no owner-MFA are real gaps
ARCHITECTURE:          8.0/10   Entitlement engine, audit trail, realtime, and
                                 timezone handling are all genuinely solid
FEATURES:              8.0/10   Extremely broad surface already built; gaps are
                                 real but bounded, not missing subsystems
DATABASE:              8.5/10   Excellent constraint discipline and tested
                                 concurrency control; one defense-in-depth gap
UX:                    7.5/10   Good loading/empty/error states and camera-
                                 permission handling; a few rough edges
TESTING:               6.5/10   Excellent unit/DB-concurrency coverage; E2E is
                                 thin and has zero platform-admin coverage
OPERATIONS:            6.0/10   CI pipeline built but deploy gate is off;
                                 backup tested but manual; monitoring inert
NEPAL READINESS:       6.0/10   Honest, correct disclaimers throughout; the
                                 underlying compliance feature set is minimal
COMMERCIAL READINESS:  7.0/10   Broad feature set, no false claims anywhere;
                                 missing support tickets, alerts, revenue view
```

## Verdict: PILOT READY, not yet PRODUCTION READY

Nothing found in this audit requires re-architecture — every P0 is closeable without touching the system's core design (a shared rate-limit store, a written policy document, an environment variable, and a batch of E2E tests). That's a meaningfully different, better starting position than the master prompt's own framing assumes. The honest gap between where this stands today and a genuine "production ready, sell it to real restaurants at scale" verdict is the P0 list above, plus the P1 items that most directly touch commercial operation (owner MFA, revenue visibility, support tickets, the attendance-analytics correctness bug, and the coupon revenue-leakage gap).

## Suggested next step

Work through the P0 list first, as one scoped phase (or a few), verified and committed the same way the prior 17 phases were — then move to the highest-impact P1 items. This audit made no code changes; nothing here is fixed yet.
