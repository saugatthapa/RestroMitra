# RestroMitra — Release Readiness Scorecard

Companion document to `FINAL_RELEASE_AUDIT.md` (the full findings) — this is the condensed scorecard and the explicit pilot/commercial-readiness answers the release-candidate review process requires.

```text
Baseline commit: 3601424d5c7b7514020894c45102860762ac34e
Final commit:    891bb74d21d5a6f95bc05a3809fdb56ad948d8ba
Commits in pass: 13
Tests:           696 passing (92 files) — up from 648 (81 files) at baseline
E2E:             5/5 passing
TypeScript:      clean (npx tsc --noEmit, exit 0)
Lint:            clean (0 errors, 6 pre-existing warnings unrelated to this pass)
Build:           clean (npm run build, exit 0)
npm audit:       3 high (sharp/postcss, via next@15.5.23's own dependency tree) — unreachable in this app (next/image is never imported anywhere in src/; confirmed by full-repo grep), fix requires a breaking Next 16 upgrade, deferred — see FINAL_RELEASE_AUDIT.md §38
```

## Scorecard

| # | Category | Status | Notes |
|---|---|---|---|
| 1 | Tenant isolation | Ready | Verified across ~78 API routes + spot-checked resource-ownership re-verification; one deferred P2 hardening item (composite FK backstop for branch_id/restaurant_id), no found exploit path. |
| 2 | RBAC / permissions | Ready | 19 granular permissions, all server-resolved; deny-path test coverage genuinely exercised, not just allow-paths. |
| 3 | Database integrity & migrations | Ready | Schema/migration drift-free; idempotency keys + 14 CHECK constraints added this pass as defense-in-depth. |
| 4 | Concurrency / race safety | Ready | Core money/stock/reservation locking already correct; reservation-status and attendance-clock-out CAS gaps fixed this pass. |
| 5 | Payment & order idempotency | Ready | Orders already had it; payments gained a matching `clientRequestId` this pass. |
| 6 | Payment gateway state machine | Ready | The one real P0 (callback failure-path status downgrade) fixed this pass; success-path locking/re-verification was already correct. |
| 7 | Financial ledger | Ready | Every write/ledger pairing is transactional; one P2 test-coverage gap (untested rollback on non-inventory pairings) left as backlog. |
| 8 | Inventory & COGS | Ready | Atomic stock movements, weighted-average costing already correct; refund-exclusion bug in COGS/revenue reporting fixed this pass. |
| 9 | Reservations | Ready | Double-booking is genuinely serialized; the one gap (status-transition CAS) fixed this pass. |
| 10 | Table management (transfer/merge/hold-resume) | Not built | Confirmed absent — no schema, no routes, no UI. Scoped backlog item, not a bug. |
| 11 | Cash register / shift management | Not built | Confirmed absent. Substantial from-scratch feature — explicitly deferred past this pass. |
| 12 | End-of-day closing | Not built | Confirmed absent. Depends on cash-register groundwork above. |
| 13 | Supplier dues / accounts payable | Not built | Confirmed absent. Scoped backlog item. |
| 14 | Payroll | Partial | Salary configs + payments exist; no payslip generation, no statutory (PF/SSF/TDS) computation. |
| 15 | Audit log | Ready | Write side existed since Phase 2 (55+ call sites); read endpoint + dashboard page added this pass. |
| 16 | Data export | Not built | No CSV/Excel/PDF export for any module. Scoped backlog item spanning many modules. |
| 17 | Account recovery & authentication | Partial | Login/register already solid (enumeration-safe, timing-safe). Self-service change-password + logout-other-sessions added this pass. Full forgot-password (needs an email/SMS delivery decision) intentionally not built — a half-built reset flow would be a worse outcome than a scoped follow-up. |
| 18 | Security headers & CSRF | Ready | No findings this pass. |
| 19 | Rate limiting | Ready, with a documented constraint | Correct for the actual single-instance deployment target; `getClientIp()` spoofing gap fixed this pass; deploy docs corrected to stop presenting multi-instance hosts as drop-in equivalents. |
| 20 | Realtime (Push/SSE) | Ready | No findings this pass. |
| 21 | Offline POS | Ready | No P0/P1 findings this pass. |
| 22 | QR ordering & printing | Ready | ESC/POS control-byte injection (P0) fixed; QR revocation/regeneration added this pass. |
| 23 | Reporting | Ready | Refund-exclusion bug (revenue/COGS) fixed this pass; otherwise correct. |
| 24 | Production readiness (CI/CD, backups, deployment, dependency audit, Nepal compliance) | Ready, with caveats | CI pipeline and backup/restore have no findings. Dependency audit: 3 high-severity, confirmed unreachable, deferred with a tracked P1 for the pre-announced Next 15.5.24 patch. Nepal IRD/PAN-VAT compliance needs a qualified professional's sign-off before commercial launch — explicitly out of scope for a code audit. |

## Explicit readiness answers

**Is this ready for a controlled pilot?** **YES.** Every identified P0 (payment-state-machine downgrade, ESC/POS injection, idempotency/CHECK-constraint gaps) is fixed and regression-tested. Core tenant isolation, RBAC, concurrency, and financial correctness were independently re-verified, not assumed from prior commit messages. A pilot restaurant's day-to-day operations (orders, payments, refunds, reservations, inventory, reporting) sit on a genuinely solid foundation.

**Is this ready for broad commercial launch?** **NO — not yet, and not because of any known bug.** Every P1/P2 *correctness or security bug* found by this audit was fixed this pass. What remains is a set of real, substantial *features* several restaurants will expect before paying for a full commercial rollout: cash register/shift management, end-of-day closing, supplier dues/AP, data export, full forgot-password, MFA, order status history, physical stock count, table transfer/merge/hold-resume, customer credit, combos/coupons. These are scoped backlog items, not defects — attempting all of them in this same pass, at the same test rigor as the bug fixes above, was judged worse than shipping them as a clearly-prioritized follow-up (see `FINAL_RELEASE_AUDIT.md`'s own "DO NOT OVERBUILD" reasoning).

**Are all identified P0s fixed?** **YES.** Three: payment-gateway-callback status downgrade, ESC/POS control-byte injection, and the payments-idempotency/CHECK-constraint gap (reclassified from P1 to P0-adjacent priority given real double-charge risk).

**Are all identified P1 bugs fixed?** **YES**, with two explicitly deferred low-risk hardening items, both documented with reasoning: (1) a composite FK backstop for `branch_id` belonging to the same `restaurant_id` (§1 — zero found exploit path today, pure defense-in-depth); (2) untested-but-structurally-identical ledger-rollback coverage for non-inventory pairings (§7). Neither is a demonstrated bug.

**Is production configuration correct?** **YES for the actual deployment target** (single-instance Hostinger Node.js hosting) — this pass corrected documentation that previously presented incompatible multi-instance hosts (Vercel, pm2 cluster) as equally valid, and hardened `getClientIp()` against the X-Forwarded-For spoofing that would have defeated IP-keyed rate limits regardless of instance count.

**Is backup/restore in place?** **YES.** No findings this pass (see `BACKUP_RESTORE.md` and `FINAL_RELEASE_AUDIT.md` §41).

**Is Nepal regulatory compliance confirmed?** **NOT APPLICABLE to this audit.** Tax configuration is kept separate from UI logic specifically so it can be adjusted without a rearchitecture, but current Nepal IRD / billing-software / PAN-VAT requirements need sign-off from a qualified professional before commercial launch — this is a legal/compliance question, not a code-correctness one, and out of scope for what this pass can verify.

## FINAL SCORE: 7.8/10

This is not a 10 — several substantial, real features restaurants will expect for a full commercial launch remain unbuilt, and that gap is what the score reflects, not any known defect. It is not lower than 7.8 because every genuine bug this audit's ten independent investigations found — including the three P0s, each with a concrete, realistic failure scenario (a customer double-charged, a customer's own order note kicking a real cash drawer, a legitimate payment retry silently double-inserting) — was actually fixed, regression-tested, and verified against the full test suite, not just described as fixed. The foundation (tenant isolation, RBAC, concurrency, financial correctness, security) is genuinely solid enough to run a real pilot restaurant on today. What separates this from a higher score is scope, not quality: cash register, end-of-day closing, supplier AP, data export, MFA, and a handful of smaller unbuilt features are real gaps for anyone evaluating this as a complete commercial product right now.
