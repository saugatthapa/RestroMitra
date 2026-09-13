# Accounting Module — Phase 4, Slice 4a Completion Report

Status: **Slice 4a complete** (Sales + Cost of Goods Sold, automatically
posted on order completion) — the first of Phase 4's automatic
integrations, per `ACCOUNTING_PHASE_4_PLAN.md`. Built exactly to that plan
and to `ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §1/§6, with one real
arithmetic correction to the matrix found and fixed along the way (below).

## What was built

**The opt-in gate (Part 1 of the plan).** `restaurants.automaticPostingEnabledAt`
(nullable timestamp, migration `0083`) — `NULL` for every restaurant that
existed before this shipped, and for any new restaurant until someone
deliberately turns it on. A new "Enable automatic posting" action on the
Accounting Overview tab (`MANAGE_ACCOUNTING`-gated, shown once a chart of
accounts exists) is the only way to set it, via a new
`POST .../accounting/enable-automatic-posting` route. There's no "disable"
action, by design — see the column's own comment in `schema.ts`. Every
automatic posting reads this flag first, inside its own transaction
(`isAutomaticPostingEnabled()`), and is a pure no-op when it's unset —
**this is what makes this change safe for every existing restaurant**:
nothing changes for them unless they explicitly opt in.

**The account-mapping resolver (Part 2.1).** `resolveAccountMappings()` in
`src/lib/accounting/account-mappings.ts` — batch-resolves a set of
`MAPPING_KEYS` to live account ids in one query, throwing a clear
`AccountingError` if any key is unmapped or its account has been
deactivated. Every integration slice from here on reuses this.

**The deactivation guard (Part 2.3).** `PATCH .../chart-of-accounts/[accountId]`
now refuses to deactivate an account that's the target of an active
mapping, naming which mapping it serves — closes the most likely way a
restaurant could accidentally break its own automatic posting after
enabling it (e.g. "cleaning up" the chart of accounts).

**The Sales + COGS posting itself**
(`src/lib/accounting/integrations/order-completion.ts`), wired into the
order-status route's existing `targetStatus === "completed"` block,
right alongside the existing `recordSalesLedgerEntry` call — additive,
not a replacement; Account Books keeps writing exactly as before. Per the
matrix's §1/§6:

- Groups this order's payments by method, builds one debit line per
  method actually used, plus Accounts Receivable for whatever's still
  unpaid (a fully-on-credit order gets a single AR line, no clearing line
  at all).
- Credits Sales Revenue at the gross (pre-discount) subtotal, Discounts &
  Allowances is debited separately when there's a discount, Service
  Charge Revenue/Tax Payable/Tips Payable are credited only when nonzero.
- Posts a second, separate voucher for Cost of Goods Sold (Dr COGS, Cr
  Inventory) when the order has any recipe-costed items, using the same
  `sourceId` with a different `posting_event` so the two never collide.
- Both use `postVoucher()`'s own idempotency key
  (`order_completion`/order id/`sale` or `cogs`), so a retried request can
  never double-post.
- Passes `allowClosedPeriod: true` unconditionally (Part 2.4 of the plan)
  — the existing daily-close lock is the real gate on whether today can
  still be touched; the accounting-period lock is for protecting
  manual/backdated journal entries, not for blocking a real-time
  operational event.

## A correction to the posting matrix, found while implementing this

The matrix's §1 table said the Dr clearing-account lines were "sum of
those payments' `amountInPaisa`" — but `amountInPaisa` deliberately
excludes a payment's tip (`payments.tipInPaisa` is a separate column, by
design — see that column's own comment). The money that physically lands
in the till or gateway includes the tip: a Rs 500 cash payment against a
Rs 450 bill (Rs 50 tip) puts the full Rs 500 in the drawer. The matrix's
own balancing proof, directly below that table, already assumed tips were
folded into the Dr clearing total — the table cell itself just hadn't
been updated to match, so following it literally would have posted an
unbalanced voucher on any order with a tip. Caught by working through the
actual arithmetic while implementing, not by a test failure — the
implementation follows the proof (debit = bill amount + tip, per method),
and `ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §1 has been corrected to
match, with a note explaining why.

## Verification

- 9 new integration tests (`accounting-integration-sales.test.ts`) against
  real order/payment/order-item fixtures: cash-only, split cash+card,
  fully-on-credit (zero payments), a discount (proving Sales Revenue posts
  at the gross subtotal), a tip (proving the corrected math above), a
  recipe-costed item (proving the separate COGS voucher), idempotent
  replay (posting twice produces one voucher), and both of
  `resolveAccountMappings`'s error paths (missing mapping, deactivated
  account). All 9 passing.
- Full suite: 1527 passed (up from 1518 — the 9 new tests), same 8
  pre-existing environment-only failures as every prior phase (missing
  `GROQ_API_KEY`, dev `PORT` mismatch) — confirmed unrelated, not a
  regression.
- `tsc --noEmit`, `eslint .`, `npm run build`: all clean.
- Live dev-server smoke test: the Accounting page still redirects cleanly
  when unauthenticated (307); the new `enable-automatic-posting` route and
  the changed `chart-of-accounts/[accountId]` PATCH route both return a
  clean 401 for an unauthenticated request with a valid CSRF header (no
  500s) — confirming the new/changed routes are wired correctly end to
  end, not just type-checked.

## What Slice 4a deliberately does NOT do

No posting for payments/refunds recorded after an order is already
completed (that's Slice 4b — settling Accounts Receivable/refunds), no
purchases/expenses/payroll/reconciliation postings (Slices 4c–4f), and no
automated test for the chart-of-accounts deactivation guard specifically
(verified instead via the live smoke test above and by inspection — it's
a small, low-traffic admin-action guard; a dedicated test can be added
alongside Slice 4b's own test work if that seems worthwhile). Tip-refund
splitting, purchase/payroll payment-method defaults, and the other five
open decisions in `ACCOUNTING_PHASE_4_PLAN.md` Part 5 remain exactly as
flagged there — none of them affect Slice 4a, all of them will need a
quick confirmation as their own slice comes up.

## Next step

Slice 4b — payment settlement (Accounts Receivable) and refunds — per
`ACCOUNTING_PHASE_4_PLAN.md`. Not started; awaiting confirmation to
proceed.
