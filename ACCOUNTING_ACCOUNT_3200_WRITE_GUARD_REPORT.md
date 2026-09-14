# Account 3200 (Opening Balance Equity) Write-Guard

Small, standalone fix flagged in `ACCOUNTING_PHASE_5_PLAN.md` Part 1.2 and
listed as an open decision needing sign-off in Part 5, #8 — closed now on
its own, per your go-ahead.

## What existed before this fix

`ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §12's own rule — "this is the
only voucher ever allowed to touch account 3200" — was a policy statement,
not an enforced one. The generic Journal Voucher route accepts any
combination of accounts and lines a human enters, with no restriction
tying it to sales/expenses/etc., so nothing stopped a manual journal entry
from also posting to Opening Balance Equity at any later date, which would
corrupt the one-time cutover plug the opening-balance route computes.

## What this fix does

Adds the guard to `postVoucher()` itself in `src/lib/accounting/post-voucher.ts`
— the single choke point every voucher, manual or automatic, is created
through — rather than only on the journal-voucher route as the plan's own
text suggested. This is a deliberate small improvement on the plan: it
protects every present and future voucher-creating code path with one
check, not just the one route a human happens to use today.

The check: if `voucherType !== "opening_balance"` and any line in the
voucher targets the account mapped to `MAPPING_KEYS.OPENING_BALANCE_EQUITY`
(seeded as "3200 Opening Balance Equity"), `postVoucher()` now rejects with
a clear message instead of posting. It's a direct, lenient lookup (not
`resolveAccountMappings()`'s own strict "throw if the mapping is missing"
behavior) — a restaurant that hasn't mapped, or hasn't yet seeded, that
account has nothing to guard, so an unrelated voucher for such a
restaurant is never blocked by a missing mapping. The one-time opening
balance voucher itself (`voucherType: "opening_balance"`) is unaffected —
it's still the only thing allowed to touch 3200, now enforced rather than
just documented.

## Verification

- `tsc --noEmit`: clean.
- `eslint .`: 0 errors in both files this fix touched.
- `vitest run`: **1592 passed** (1591 baseline + 1 new, in
  `accounting-posting.test.ts`) — a manual journal voucher targeting 3200
  is rejected with the new guard's own message, and a genuine
  `opening_balance` voucher targeting the same account still posts fine
  (the guard is scoped to voucher type, not to the account alone). All
  other pre-existing accounting integration tests pass unchanged. The
  same 8 pre-existing, unrelated failures (a port-mismatch in the eSewa
  gateway callback test, a branch-filtering push-notification test, and a
  missing `GROQ_API_KEY` environment variable affecting two
  AI-provider-config tests) are untouched by this change.
- `npm run build`: succeeds.
- Dev server smoke test: the vouchers route's existing `401`/`400`
  behavior (unauthenticated GET / missing-CSRF POST) is unchanged.

## Scope

Standalone, one-file behavioral change plus its test — no schema, no
migration, no UI change. Every existing automatic posting integration
(sales, expenses, payroll, purchases, fixed assets, loans, bank
reconciliation) never targets account 3200 in the first place, so none of
them are affected by this guard; only a hand-entered Journal Voucher
deliberately selecting that account is.
