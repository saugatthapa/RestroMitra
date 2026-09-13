# RestroKendra Accounting Policy & Posting Matrix

Status: **planning only — no schema or code changes made yet.** Companion to
`ACCOUNTING_MODULE_PLAN.md`. That document proposes the architecture (tables,
posting engine, phases); this document is what an external accounting review
of that plan asked for before Phase 4 (the automatic integrations) can start:
**one explicit, approved debit/credit answer for every business event this
module will touch**, grounded in this codebase's actual schema fields rather
than a generic textbook example — so the accounting decisions get made here,
once, instead of by whoever happens to be writing the integration code later.

Every posting below produces one balanced voucher (`sum(debit) == sum(credit)`)
through the single `postVoucher()` choke point described in the plan. Postings
triggered automatically by an existing operational event (order completion, a
payment, an expense being paid, …) always carry a `source_type` / `source_id` /
`posting_event` triple as their idempotency key, so a retried request can never
double-post the same real-world event — see the plan's "Idempotency" section
for the mechanics. Manual journal vouchers (entered by hand on the Phase 2
screen) carry none of those three and aren't subject to that constraint.

**Decisions confirmed (via the two policy questions this document's earlier
draft raised):**
1. **Service charge → restaurant revenue**, not a staff payable. Booked the
   same way sales revenue is, at the same moment.
2. **Discounts → a contra-revenue account** (Discounts & Allowances), not
   netted silently into Sales Revenue. The P&L will show Gross Sales, less
   Discounts & Allowances, equals Net Sales.

One more business-policy call is flagged as **not yet decided**, because it
only matters once Phase 4/5 actually reaches payroll — see §8 below. Nothing
else in this document is blocked on it.

---

## Chart of accounts (the seed set Phase 1 should create)

This is deliberately not a generic textbook chart of accounts — every account
below exists because a specific row in the matrix needs it. More accounts can
be added later (via the normal Chart of Accounts screen, Phase 2), but this is
the minimum the integrations in this document require.

| Code | Account | Type | Notes |
|---|---|---|---|
| 1000 | Cash on Hand | Asset | May be split per branch (see the plan's account-scoping section) — mirrors existing per-branch Cash Register shifts |
| 1010 | Card Clearing | Asset | Money taken by card, not yet settled to the bank |
| 1020 | Mobile Wallet Clearing | Asset | Same, for `mobile_wallet` |
| 1030 | Other Clearing | Asset | Same, for `other` |
| 1040 | Bank Account(s) | Asset | One row per `bank_accounts` entry, Phase 5 |
| 1100 | Accounts Receivable | Asset | One control account; `customer_id` on the voucher *line* gives the per-customer sub-ledger/aging (matches `accounting_voucher_lines.customer_id` already in the plan's schema) |
| 1200 | Inventory | Asset | Fed by weighted-average costing, unchanged |
| 1900 | Fixed Assets | Asset | Phase 5 |
| 1910 | Accumulated Depreciation | Asset (contra) | Phase 5 |
| 2000 | Accounts Payable | Liability | Control account; `supplier_id` on the line gives the sub-ledger, same pattern as 1100 |
| 2100 | Tax Payable (Output) | Liability | |
| 2200 | Tips Payable | Liability | See §10 — tips are staff money, never restaurant revenue |
| 2300 | Salary Payable | Liability | Only used if/when accrual payroll is adopted, §8 |
| 2400 | Loans Payable | Liability | Phase 5 |
| 3000 | Owner Capital | Equity | |
| 3100 | Owner Drawings | Equity (contra) | |
| 3200 | Opening Balance Equity | Equity | Suspense/plug account, used exactly once per cutover, §12 |
| 4000 | Sales Revenue | Income | Booked at the **gross** (pre-discount) subtotal — see §4 |
| 4010 | Service Charge Revenue | Income | Decision #1 above |
| 4900 | Discounts & Allowances | Income (contra) | Decision #2 above |
| 4910 | Sales Returns & Refunds | Income (contra) | §2 — kept separate from Discounts & Allowances since a refund is a reversal of a completed sale, not a point-of-sale discount |
| 5000 | Cost of Goods Sold | Expense | Fed by the existing `recipeCostInPaisa` snapshot, unchanged |
| 5100 | Salary Expense | Expense | |
| 5200+ | Expense category accounts | Expense | One per existing expense category, via `account_mappings` (`expense_category:<id>`) — not hard-coded, per the plan's own §42/§43 |

---

## 1. Sale — order marked `completed`

**Existing trigger:** `status/route.ts`, the `targetStatus === "completed"` block
that already calls `recordSalesLedgerEntry` — booked once per order, regardless
of payment status, exactly as today. **This is also where COGS posts (§6)** —
same source event, two separate `posting_event` values so they don't collide.

`source_type: "order_completion"`, `source_id: order.id`, `posting_event: "sale"`

The order's own stored fields already give every number needed —
`totalInPaisa = subtotalInPaisa − discountInPaisa + serviceChargeInPaisa + taxInPaisa`
— so nothing here is inferred:

| Line | Account | Amount |
|---|---|---|
| Dr | Cash on Hand / Card Clearing / Mobile Wallet Clearing / Other Clearing *(one line per payment method already recorded against this order as of the completion moment, grouped by method)* | sum of those payments' `amountInPaisa` |
| Dr | Accounts Receivable *(tagged `customer_id` if linked, otherwise left untagged for a walk-in)* | `totalInPaisa` − sum of payments recorded so far |
| Dr | Discounts & Allowances | `discountInPaisa` |
| Cr | Sales Revenue | `subtotalInPaisa` *(gross — this already includes the discount, per decision #2)* |
| Cr | Service Charge Revenue | `serviceChargeInPaisa` |
| Cr | Tax Payable | `taxInPaisa` |
| Cr | Tips Payable | sum of `tipInPaisa` on those same payments, §10 |

This balances by construction: `total(Dr cash/clearing lines) + AR + discount = subtotal + serviceCharge + tax + tips`, and `subtotal − discount + serviceCharge + tax = total` is already a DB-enforced invariant (`orders.totalInPaisa`'s own check constraint), so the two sides are always equal.

If the order has zero payments at completion (fully on credit), the single Dr line is the full amount to Accounts Receivable — no clearing-account line at all.

## 2. Later payment / refund against an already-completed order

**Settling AR** (a customer pays down a tab after the order was already
completed and its full revenue already recognized in §1) — `source_type:
"payment_settlement"`, `source_id: payment.id`, `posting_event: "settlement"`:

| Line | Account | Amount |
|---|---|---|
| Dr | Cash on Hand / Card Clearing / Mobile Wallet Clearing / Other Clearing | payment amount |
| Cr | Accounts Receivable *(same customer_id tag)* | payment amount |

**Refund** (negative `payments` row, existing refunds route) — `source_type:
"refund"`, `source_id: payment.id` (the refund row itself), `posting_event:
"refund"`:

| Line | Account | Amount |
|---|---|---|
| Dr | Sales Returns & Refunds | refund amount, excluding any refunded tip |
| Dr | Tips Payable *(only if the tip portion is also being refunded)* | refunded tip amount |
| Cr | Cash on Hand / Card Clearing / Mobile Wallet Clearing / Other Clearing | total refunded |

Kept as a **separate contra-revenue account (4910)** from Discounts &
Allowances (4900) deliberately — a discount is a point-of-sale pricing
decision on a still-open order; a refund is a reversal of revenue that was
already fully recognized. Conflating them would make either report
misleading on its own.

## 3. Combine bill (multi-order table settlement, built earlier this session)

No new posting logic — `recordCombinedPayment` already inserts ordinary rows
into the same `payments` table, one per order, so each one flows through §1
(if that order is completing at the same time) or §2 (settlement against an
already-completed order) exactly as if it had been paid individually. The
`clientRequestId`-namespacing that already makes combine-bill replay-safe at
the payments layer means the accounting layer's own idempotency key (keyed off
`payment.id`) never even sees a duplicate to worry about.

## 4. Purchase (stock-in from a supplier)

`source_type: "purchase"`, `source_id: purchase.id`, `posting_event: "purchase"`

| Line | Account | Amount |
|---|---|---|
| Dr | Inventory | `purchases.totalInPaisa` |
| Cr | Accounts Payable *(tagged `supplier_id`)* — if `isCredit`, **or** Cash on Hand / Bank — if paid immediately | `purchases.totalInPaisa` |

**Supplier payment** (settling AP later) — mirror of §2's AR settlement:
Dr Accounts Payable (same `supplier_id` tag), Cr Cash on Hand / Bank.

## 5. Expense

`source_type: "expense_payment"`, `source_id: expense.id`, `posting_event: "paid"`
— fires exactly once, at the same "paid" moment `recordExpenseLedgerEntry`
already fires at today (never at pending/approved).

| Line | Account | Amount |
|---|---|---|
| Dr | the expense's category account (via `account_mappings`, `expense_category:<id>`) | expense amount |
| Cr | Cash on Hand / Card Clearing / Bank (per `paymentMethod`) | expense amount |

**Reversal/void** (`reverseExpenseLedgerEntry`) — `posting_event: "voided"` —
the exact mirror image, never editing the original voucher.

## 6. Inventory consumption / COGS

Same trigger and source as §1 (order completion), different `posting_event`
so the two never collide: `posting_event: "cogs"`.

| Line | Account | Amount |
|---|---|---|
| Dr | Cost of Goods Sold | sum of `orderItems.recipeCostInPaisa` for this order (the existing frozen-snapshot mechanism, via `getCogsSummary()` — unchanged) |
| Cr | Inventory | same amount |

## 7. Cash Register movements (open/close/addition/drop/payout)

**Deliberately NOT auto-posted to the general ledger.** This matches a
decision already made earlier in this engagement (and re-confirmed by the
external review): Cash Register answers "what should physically be in the
drawer," which is a different question from "what happened financially," and
the two are kept structurally separate. The cash *sales* that flow through the
drawer are already captured by §1's Sales Voucher at the payment-method level
(Cash on Hand); a register addition/drop/payout is an internal movement of
physical cash (e.g., between drawer and safe) that doesn't, by itself, change
any GL account balance the module tracks. If a restaurant later wants
register drops formally posted as transfers to a "Cash in Safe" account, that
can be added as an explicit opt-in in Phase 5 — it is not assumed here.

## 8. Payroll — ⚠️ one open policy question

**Not yet decided; flagged rather than guessed, since it changes what Salary
Payable (2300) is even for.** Today, payroll only records a payout — there is
no accrual step. Two honest options exist for Phase 4/5:

- **Cash-basis (matches today's only behavior):** at payout, one voucher —
  Dr Salary Expense, Cr Cash on Hand / Bank. Simple, and doesn't require
  building a new "salary becomes due" trigger that doesn't exist today.
- **Accrual-basis (the pasted spec's own §22):** a new accrual step at
  period-end — Dr Salary Expense, Cr Salary Payable — followed by Dr Salary
  Payable, Cr Cash/Bank at actual payout. More correct accounting (expense
  recognized when earned, not when paid) but requires deciding exactly when
  "period-end" fires for a given staff member's schedule, which is new product
  surface, not just new posting logic.

**Recommendation:** ship cash-basis in Phase 4 (matches current behavior,
zero new triggers), and revisit accrual as an explicit Phase 5+ opt-in once
there's a real payroll-period concept to hang it on. This should be confirmed
before Phase 4's payroll integration specifically — it doesn't block Phase 1,
2, or 3.

## 9. Reconciliation → bank settlement

**Existing trigger:** the reconciliation feature already marks a card/wallet/
other payment `reconciledAt`. This is the natural point money moves from
"clearing" to "actually in the bank." `source_type: "payment_reconciliation"`,
`source_id: payment.id`, `posting_event: "reconciled"`:

| Line | Account | Amount |
|---|---|---|
| Dr | Bank Account | payment amount |
| Cr | Card Clearing / Mobile Wallet Clearing / Other Clearing (matching the payment's method) | payment amount |

Cash is correctly excluded here too, same as the existing reconciliation
feature already excludes it (`RECONCILABLE_METHODS` doesn't include cash) —
cash never sits in a clearing account, it's Cash on Hand from the moment
it's collected.

## 10. Tips

Tips are explicitly "separate money for staff, not part of the bill" per the
existing `payments.tipInPaisa` column's own design (see §1 — tips are never
included in `orders.totalInPaisa`). Accordingly they are **never restaurant
revenue**: every tip collected credits Tips Payable (a liability) at the same
moment the payment itself is booked (§1 or §2, whichever applies). No
distribution mechanism exists yet in this codebase, so Tips Payable simply
accumulates until a future feature distributes it to staff — building that
distribution feature is out of scope here, but the liability account exists
now so tips are never silently miscounted as the restaurant's own income in
the meantime.

## 11. Owner capital / drawings

No existing trigger — these only ever happen via a manual Journal Voucher
(Phase 2's entry screen), the same as any restaurant's real-world owner
investment or withdrawal:

- Investment: Dr Cash on Hand / Bank, Cr Owner Capital.
- Withdrawal: Dr Owner Drawings, Cr Cash on Hand / Bank.

The existing Account Books `capital`/`withdrawal` manual-entry categories can
optionally be mapped to these same accounts via `account_mappings` if a
restaurant wants a smoother transition, but the recommended path post-cutover
is simply using the new Journal Voucher screen directly.

## 12. Opening Balance Voucher (cutover)

One-time, manual, dated on the chosen cutover date (per the plan's clean-cutover
decision) — every asset account's opening balance is debited, every liability
and equity account's opening balance is credited, with **Opening Balance
Equity (3200)** as the plug/suspense account absorbing whatever the two sides
don't otherwise agree on (since reconstructing historical retained earnings
precisely is explicitly out of scope — that's what "clean cutover" means).
This is the only voucher ever allowed to touch account 3200.

---

**Where this leaves things:** every business event this module needs to
handle now has one specific, approved answer — this is what Phase 1's seed
chart of accounts should be built to match, and what Phase 4's integrations
should implement one row of this document at a time (same "land it as several
small, separately-tested changes" approach the plan already recommends for
that phase). The one open item (§8, payroll cash-basis vs accrual) only needs
resolving once Phase 4/5 actually reaches payroll — everything else here is
ready to build against as-is.
