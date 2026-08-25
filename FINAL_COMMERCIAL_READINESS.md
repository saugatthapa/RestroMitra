# RestroMitra — Final Commercial Readiness Report

Companion to `RELEASE_READINESS.md` / `FINAL_RELEASE_AUDIT.md` (the pilot-readiness audit as of commit `891bb74`, score 7.8/10, "ready for pilot, not yet for broad commercial launch"). This report covers everything built **since** that baseline — the "Commercial Launch Phase A" and "Phase B" work — and closes out the specific feature list that audit flagged as missing, then gives a final verification pass and GO/NO-GO call for broad commercial launch.

```text
Baseline commit:  891bb74d21d5a6f95bc05a3809fdb56ad948d8ba  (RELEASE_READINESS.md snapshot)
Final commit:     83b7eef6e3bdbf390a03ba57cf0a51c082eb5b21
Commits in pass:  20 (Phase A.1–A.8, Phase B.1–B.9)
Tests:            905 passing (111 files) — up from 696 (92 files) at baseline
E2E:              5/5 passing (owner-login, qr-order, reservations, staff-order-management)
TypeScript:       clean (npx tsc --noEmit, exit 0)
Lint:             clean (0 errors, 6 pre-existing warnings unrelated to this pass — see below)
Build:            clean (npm run build, exit 0, all 50 static/dynamic routes generated)
npm audit:        3 high (sharp/postcss, transitive via next@15.5.23's own tree) — fix requires a
                   breaking Next 16 upgrade, deferred; same finding RELEASE_READINESS.md already
                   carried at baseline, unchanged by this pass
```

## Scope and honesty note (Section 66)

This report is **not** a fresh line-by-line security re-audit of every phase below, the way `FINAL_RELEASE_AUDIT.md` was for the pre-baseline codebase. What it actually verifies, and how:

- **Phase B.6–B.9 (Coupons, Table Operations, Combos, Split Bill)** were implemented, tested, and reviewed directly in this engagement, with the full quality bar from the governing spec applied to each: tenant isolation, branch isolation, CAS/row-locking where money or a shared resource is at stake, transactional writes, permission gating, and test coverage across happy path / unauthorized / wrong-restaurant / wrong-branch / validation failure / duplicate request / concurrent request / rollback / edge case. Details below.
- **Phase A.1–A.8 and Phase B.1–B.5** predate this specific engagement window. They're described below from the code as it stands today (schema, lib, routes, permission gates, test files) — confirmed to exist and pass, not re-derived from commit messages alone — but were not re-audited line-by-line for new findings the way the P0/P1/P2 passes did for the pre-baseline code.
- **The full regression suite (905/905), full e2e suite (5/5), typecheck, lint, and production build all ran clean at the final commit above**, covering every phase's own test suite simultaneously. This is strong evidence of no regressions anywhere in the system today, even for code this report doesn't narrate in security-audit depth.

## What shipped since the baseline

### Phase A — operational foundations

| # | Feature | Where | Gate | Tests |
|---|---|---|---|---|
| A.1 | Cash Register / Shift Management — open/close a till shift, cash movements, expected-vs-actual variance, append-only corrections | `src/lib/cash-register.ts`, `.../register-shifts/**`, `/dashboard/register` | `MANAGE_CASH_REGISTER` | `cash-register.test.ts` (11) |
| A.2 | Daily Closing — locks a business day's sales/purchases/expenses/stock into a snapshot after shift close | `src/lib/daily-closing.ts`, `.../daily-closes/**`, `/dashboard/daily-closing` | `MANAGE_DAILY_CLOSING` | `daily-closing.test.ts` (7) |
| A.3 | Supplier Dues / AP — credit purchases, due report, purchase voiding | `src/lib/supplier-dues.ts`, `.../purchases/**`, `.../suppliers/due-report` | `MANAGE_INVENTORY` | `supplier-dues.test.ts` (10) |
| A.4 | COGS snapshot — freezes each order line's recipe cost at sale time so historical margin reports never drift when today's ingredient costs change | `orderItems.recipeCostInPaisa`, wired in `src/lib/inventory.ts` | n/a (internal) | covered by `cogs-reporting.test.ts`, `product-profitability.test.ts` |
| A.5 | Wastage cost snapshot — damaged/burned reasons, frozen cost basis for wastage reporting | `stockMovements.totalCostInPaisaSnapshot` | `MANAGE_INVENTORY` | `wastage-cost-snapshot.test.ts`, `wastage-reporting.test.ts` |
| A.6 | Physical Stock Count — count sheet vs. system, variance thresholds, approve/reject | `src/lib/stock-count.ts`, `.../stock-counts/**` | `MANAGE_INVENTORY` | `stock-count.test.ts` (15) |
| A.7 | Stock Transfer — branch-to-branch request → approve → dispatch → receive | `.../stock-transfers/**` | `MANAGE_INVENTORY` | `stock-transfer.test.ts` (12) |
| A.8 | Financial Reconciliation — manual checklist matching non-cash payments against bank/gateway statements | `src/lib/financial-reconciliation.ts`, `.../reconciliation/**` | `MANAGE_ACCOUNT_BOOKS` | `financial-reconciliation.test.ts` (13) |

### Phase B — the commercial-launch punch list

| # | Feature | Where | Gate | Tests |
|---|---|---|---|---|
| B.1 | Order Status History + Order Performance reporting — a structured row per real status transition, powering stage-duration/SLA metrics | `src/lib/order-status-history.ts`, wired into the status route, consumed by Reports | `VIEW_REPORTS` (reporting) | `order-performance.test.ts` (7) |
| B.2 | Payroll ← Attendance — owed amount computed from actual attendance (daily = rate × days present, hourly = rate × minutes ÷ 60, monthly = flat, not prorated by design) | `src/lib/payroll.ts` | `MANAGE_PAYROLL` / `VIEW_PAYROLL` | `payroll-computation.test.ts` (10) |
| B.3 | Forgot Password — self-service reset via single-use short-lived tokens, plus admin-triggered staff reset | `src/lib/auth/password-reset.ts`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `.../staff/[userRoleId]/reset-password` | `MANAGE_STAFF` (admin path) | `password-reset.test.ts` (8) |
| B.4 | TOTP Multi-Factor Authentication — enroll/verify/disable, one-time backup codes | `src/lib/auth/mfa.ts`, `/api/auth/mfa/**` | authenticated self-service | `mfa.test.ts` (11) |
| B.5 | CSV Export + Customer Credit — dependency-free CSV serializer for ledger/reconciliation exports; a running customer tab with oldest-charge-first settlement | `src/lib/csv.ts`, `src/lib/ledger.ts` (`settleCustomerCredit`) | `MANAGE_ACCOUNT_BOOKS` | `csv.test.ts` (8), `customer-credit.test.ts` (10) |
| B.6 | Coupons — reusable promo codes redeemable at checkout, sharing the order's one discount slot with manual discounts | `src/lib/coupons.ts`, `.../coupons/**`, `.../orders/[orderId]/coupon` | `APPLY_DISCOUNT` | `coupons.test.ts` (17) |
| B.7 | Table Operations — transfer, merge, hold, resume, all CAS row-locked | `src/lib/tables.ts` | `MANAGE_TABLES` (transfer/merge), `EDIT_ORDER` (hold/resume) | `table-operations.test.ts` (17) |
| B.8 | Combos — bundle menu items at a fixed price; explodes into ordinary order-item rows at order time (proportional price allocation, remainder-to-last) so KDS/recipe-deduction/reports/refunds never need combo-awareness | `src/lib/combos.ts`, `.../combos/**`, POS "Combos" tab | `EDIT_MENU` | `combos.test.ts` (15) |
| B.9 | Split Bill — item-level (partial-quantity-aware) bill splitting with per-share payment tagging, computed fresh on every read, never stored | `src/lib/bill-splits.ts`, `.../orders/[orderId]/splits`, Split Bill panel on the bill view | `EDIT_ORDER` | `bill-splits.test.ts` (17) |

This closes every item RELEASE_READINESS.md's scorecard listed as **"Not built"**: table management, cash register, EOD closing, supplier dues, data export, full forgot-password, MFA, order status history, physical stock count, stock transfer, customer credit, and combos/coupons. Split Bill (item-level, not just amount-split — see `payments` table's own doc comment on the pre-existing amount-split capability) was the one item explicitly deferred past that audit's own scope; it's built now too.

## Remaining gaps (real, not bugs)

- **Payroll payslip generation and statutory computation (PF/SSF/TDS)** — still not built. B.2 only wired attendance into the owed-amount figure; there is no payslip document and no statutory-deduction computation anywhere in the schema or lib. A manager sees the computed owed amount and records a manual payout; anything beyond that is a genuinely new feature, not a fix.
- **Nepal IRD / PAN-VAT regulatory compliance sign-off** — unchanged from the baseline audit's own finding: this needs a qualified professional's review before commercial launch, not a code audit. Tax configuration stays deliberately decoupled from UI logic so it can be adjusted without a rearchitecture, but nothing in this codebase can substitute for that sign-off.
- **Combos and Split Bill are scoped to staff POS only**, not the public QR customer-ordering flow — a deliberate, bounded decision made this session to ship a correct, well-tested staff-side feature rather than a rushed version spanning both surfaces. Extending either to QR ordering is a scoped follow-up, not a defect.
- **npm audit: 3 high-severity transitive vulnerabilities** (`sharp`/`postcss`, pulled in by `next@15.5.23` itself) — unchanged from baseline. Fixing requires a breaking Next 16 upgrade; RELEASE_READINESS.md's baseline audit separately confirmed `next/image` is never imported anywhere in `src/`, so the `sharp` path is unreachable in this app's actual usage. Deferred as a tracked dependency-upgrade item, not an active exploit path.

## Known limitations (deliberate, documented in code)

- **Daily Closing** buckets purchases by `purchases.createdAt` only — there's no separate "purchase date" column, a limitation shared with the rest of the app's purchase-dated reporting.
- **Supplier due purchase voiding** reverses stock quantity and the linked ledger entry but deliberately does **not** reverse the item's weighted-average cost — not generally reversible once later purchases/sales have touched the same item's average.
- **Financial Reconciliation** is a manual checklist by design — there is no bank-API or payment-gateway settlement integration in this codebase; a human confirms against their own statement.
- **MFA** has no SMS fallback — this app has no SMS delivery capability; TOTP + backup codes are the only two factors offered.
- **Split Bill**: redefining an order's shares (whole-state-replace) untags any payment recorded against the old share ids (`ON DELETE SET NULL`) — the payment itself is never lost, just its per-payer label.
- **Coupons and manual discounts share one discount slot per order** (pre-existing constraint, unchanged) — a coupon and a manual discount can't both apply to the same order at once.

## Final verification pass (this session)

All run at the final commit above, against the whole repository, not just the files touched this session:

- `git status` — clean, nothing uncommitted, no stray files.
- `npx tsc --noEmit` — clean, exit 0.
- `npm run lint` (full repo) — 0 errors, 6 pre-existing warnings (two unused `eslint-disable` directives, one `<img>` LCP hint, one unused variable in a payout-methods helper, two in one-off smoke-test scripts) — none in code touched this session, all pre-existing.
- `npx vitest run` (full suite) — **905 passed, 0 failed, 111 test files.**
- `npx playwright test` (full e2e suite, against a production build) — **5 passed, 0 failed.**
- `npm run build` — clean, exit 0, all 50 routes (static + dynamic) generated successfully. The `/404`-prerendering `<Html> should not be imported outside of pages/_document` error documented as a known, environment-specific issue in an earlier session (confirmed unrelated to any app code via `git stash` reproduction on an old commit) **did not reproduce in this final build** — noted here rather than silently carried forward as still-active, since it no longer is.
- `npm audit` — 3 high-severity, transitive, pre-existing (see above); no new vulnerabilities introduced by this session's dependency changes (none were made).
- Secret scan of this session's full diff (`git diff 6151216..HEAD`) — no credentials, API keys, or private key material found; the only "secret"-adjacent hits were the `mfa_secret` **column name** in Drizzle migration-snapshot JSON, not a value.

## Security status

No new P0/P1/P2 findings surfaced in this pass beyond what's already listed under "Remaining gaps" and "Known limitations" above — those are scoped feature/documentation items, not security bugs. Every new financial/tenant-sensitive route added this session (Coupons, Table Operations, Combos, Split Bill) follows the same tenant-isolation, branch-isolation, and CAS-locking patterns the baseline audit already verified for the rest of the app, and each has its own test coverage proving it (see the B.6–B.9 test-file counts above, and their own `describe` blocks' `it(...)` names for the specific unauthorized/wrong-restaurant/wrong-branch/concurrent/rollback cases each one covers).

## Commercial readiness — updated scorecard

| Category | Status |
|---|---|
| Everything in RELEASE_READINESS.md's original scorecard (tenant isolation, RBAC, DB integrity, concurrency, payment idempotency, gateway state machine, ledger, inventory/COGS, reservations, audit log, security headers/CSRF, rate limiting, realtime, offline POS, QR ordering/printing, reporting, CI/CD & backups) | **Unchanged: Ready.** No regressions — full regression suite covers all of it and passes. |
| Table management (transfer/merge/hold-resume) | **Ready** — was "Not built," now shipped (B.7), tested. |
| Cash register / shift management | **Ready** — was "Not built," now shipped (A.1), tested. |
| End-of-day closing | **Ready** — was "Not built," now shipped (A.2), tested. |
| Supplier dues / accounts payable | **Ready** — was "Not built," now shipped (A.3), tested. |
| Payroll | **Still Partial** — owed-amount computation now attendance-driven (B.2), but payslip generation and statutory (PF/SSF/TDS) computation remain unbuilt. |
| Data export | **Ready** — was "Not built," CSV export now shipped (B.5) for ledger/reconciliation. |
| Account recovery & authentication | **Ready** — forgot-password (B.3) and MFA (B.4) close both gaps the baseline flagged. |
| Combos / Coupons | **Ready, staff POS only** — both shipped and tested (B.6, B.8); public QR ordering support is a scoped follow-up, not a defect. |
| Split Bill (item-level) | **Ready, staff POS only** — shipped and tested (B.9); the pre-existing amount-only split (record N payments against one order) still works everywhere it always did. |
| Nepal IRD / PAN-VAT compliance | **Not applicable to a code audit** — unchanged from baseline; needs a qualified professional's sign-off before commercial launch. |
| Dependency vulnerabilities | **Unchanged from baseline** — 3 high-severity, transitive, confirmed unreachable in this app's actual `next/image` usage, deferred pending a Next 16 upgrade decision. |

## GO / NO-GO determination

**Is this ready for broad commercial launch, feature-wise?** **YES**, with two explicit, bounded exceptions: (1) payroll payslip/statutory computation remains a scoped follow-up feature, not a blocking defect — restaurants can still run payroll manually from the computed owed amounts; (2) Nepal tax/regulatory sign-off is outside what any code audit can confirm and must happen before launch regardless of code readiness.

**Are all P0/P1 bugs from the baseline audit fixed?** **YES** — unchanged from RELEASE_READINESS.md's own answer; nothing in this pass reopened or regressed any of them (905/905 tests, including every pre-existing test file, pass at the final commit).

**Is the new Phase A/B work itself production-quality?** **YES for B.6–B.9**, verified directly this session against the full spec's quality bar (tenant/branch isolation, CAS locking, transactional writes, permission gating, and the full happy/unauthorized/wrong-tenant/wrong-branch/validation/duplicate/concurrent/rollback/edge-case test matrix). **Presumed YES for Phase A and B.1–B.5** on the strength of their own existing, passing test suites and this session's clean full-repo regression pass — but see the "Scope and honesty note" above: those phases did not receive a fresh line-by-line security re-audit in this session the way B.6–B.9 did.

**Recommendation:** ship. The two remaining gaps (payroll statutory features, tax compliance sign-off) are known, bounded, and don't block a commercial launch on their own — they're the kind of follow-up item any live product carries, not evidence the platform isn't ready.
