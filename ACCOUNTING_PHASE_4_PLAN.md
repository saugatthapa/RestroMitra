# Accounting Module — Phase 4 Implementation Plan (Automatic Integrations)

Status: **planning only — no schema or code changes made yet.** This is the
detailed, file-and-function-level plan for Phase 4 that
`ACCOUNTING_MODULE_PLAN.md` said should exist before any of this phase's
code gets written, and that this phase's own risk level (the plan calls it
"Very Large, highest risk") earns on top of that. Nothing in this document
has been built. It should be reviewed and approved — as a whole, or slice
by slice — before any of it lands.

Every posting below is grounded in the actual call sites in this codebase
today (file, function, line-level context), not a generic description, and
implements exactly what `ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` already
specifies. Where this research surfaced a real gap the matrix didn't
anticipate — a field that doesn't exist yet, a behavior that needs a new
decision — it's called out explicitly under **Open decisions**, not guessed.

---

## Part 1 — The one prerequisite every slice depends on: an opt-in gate

This is the single most important design decision in this phase, and it
has to be settled before slice 4a starts, because every slice below builds
on it.

**The problem.** This is a live, multi-tenant SaaS with existing
restaurants already using order completion, payments, expenses, purchases,
and payroll every day. Phase 1/2/3 were safe by construction because
nothing operational called into them. Phase 4 is different: it adds a call
to `postVoucher()` inside the exact transactions that complete orders,
record payments, pay expenses, and so on. If that call assumes a chart of
accounts and account mappings exist, it will throw for every restaurant
that has never opened the new Accounting tab — which, immediately after
Phase 4 ships, is *all of them*. A thrown `AccountingError` inside
`db.transaction()` rolls back the whole transaction, so the failure mode
isn't "no accounting entry was made" — it's "the order didn't complete,"
which is exactly the regression the plan's own Part 4 warns about most
strongly.

**The fix.** Automatic posting must be **explicitly opt-in per restaurant**,
gated on something more deliberate than "did they seed a chart of
accounts" — someone might open the new Accounting tab and click "Set up
Chart of Accounts" out of curiosity without meaning to change how the POS
behaves. Recommendation:

- Add one new column: `restaurants.automaticPostingEnabledAt` (nullable
  `timestamp`). `NULL` (the default, and the value for every existing
  restaurant after migration) means "Phase 4 integrations are no-ops for
  this restaurant" — every one of the `if (automaticPostingEnabled) { ... }`
  checks below simply skips straight past. Setting it is a distinct action
  from seeding the chart of accounts: a new button on the Overview tab,
  "Enable automatic posting," gated by `MANAGE_ACCOUNTING`, shown only once
  a chart of accounts exists, with an explicit warning that this will start
  posting real vouchers from every future order/payment/expense/etc.
  automatically. This also gives a clean, honest answer to "when did this
  restaurant start using the new module for real" for support purposes.
- Every integration point below reads this flag once per request (via
  `resolveRestaurantContext`, which already loads the restaurant row, or
  one extra indexed lookup) and short-circuits to today's exact behavior —
  zero new queries, zero new writes, zero new failure modes — when it's
  unset. **This is what makes Phase 4 safe to ship**: existing restaurants
  see no change at all until they deliberately flip the switch.
- Once enabled, a posting failure (unbalanced voucher, inactive/missing
  mapped account, closed period without override) is allowed to fail the
  whole transaction. See Part 2 below for why that's the right call once
  this gate exists, and what it depends on.

**Alternative considered and rejected**: gracefully degrading (catch the
accounting error, log it, let the business operation succeed anyway) would
avoid ever blocking a sale, but it means the books can silently drift out
of sync with reality — completed orders with no matching voucher — which
defeats the actual point of double-entry accounting (it's supposed to be
the thing you can trust precisely because it can't get out of balance).
Hard-failing inside the same transaction, gated behind an explicit opt-in
that only fires once a restaurant has a working, seeded chart of accounts,
gets both properties: never surprises an existing restaurant, and never
lets an enabled restaurant's books silently diverge from its operations.

**This needs your sign-off before slice 4a starts** — it's a real product
decision (an explicit toggle, not automatic-on-seed), not just an
implementation detail.

---

## Part 2 — Cross-cutting mechanics used by every slice

### 2.1 Resolving mapped accounts

A new small helper, `src/lib/accounting/account-mappings.ts`:

```
resolveAccountMappings(tx, { restaurantId, keys: MappingKey[] }): Promise<Map<MappingKey, string>>
```

Batch-resolves a set of `MAPPING_KEYS` to their account ids in one query
(`account_mappings` joined to `chart_of_accounts`, filtered to
`isActive`), thrown as `AccountingError` if any requested key is missing
or its mapped account is inactive — this is the "hard fail" path Part 1
describes, and it should only ever actually throw for a restaurant whose
setup is broken (e.g. someone deactivated a system-mapped account after
enabling automatic posting — see 2.3), never for one that hasn't set up
accounting at all (that path never reaches this helper, per Part 1's gate).

Each integration slice below calls this once per operation with exactly
the keys it needs, not once per voucher line.

### 2.2 Payment-method → clearing account

`MAPPING_KEYS.PAYMENT_METHOD_CASH/CARD/MOBILE_WALLET/OTHER` already exist
from Phase 1's seed data and map 1:1 onto `payments.method`'s four enum
values (`cash`/`card`/`mobile_wallet`/`other`) — no new mapping keys
needed for any payment-method-driven line in this phase.

### 2.3 Protecting mappings once they're load-bearing

Today, `PATCH .../chart-of-accounts/[accountId]` lets any account be
deactivated, including one referenced by an active `account_mappings` row.
That's harmless while nothing reads mappings automatically (Phase 1–3) but
becomes a footgun the moment a restaurant enables automatic posting — an
owner deactivating "Cash on Hand" to "clean up the chart" would start
throwing `AccountingError` on every cash payment. **Add one guard** to that
existing route: reject deactivating an account that's the target of an
active `account_mappings` row, with a message naming which mapping it
serves. Small, additive, and closes the most likely way a restaurant would
accidentally break its own automatic posting after opting in.

### 2.4 Accounting periods never block an automatic posting

`postVoucher()` already treats "no period row covers this date" as open
(periods are opt-in enforcement — see its own comment), so most
restaurants are unaffected either way. But if a restaurant *has* closed a
period covering today, and a real-time operational event happens to book
into that date (a late order completing after tonight's period was
closed, for instance), that must never block the actual business action.
**Design decision**: every automatic posting in this phase passes
`allowClosedPeriod: true` unconditionally. The accounting-period lock is
for protecting manual/backdated journal entries from casual edits after a
close — the *existing* `assertBusinessDayWritable` daily-close lock is
already the real access-control point for "can this business day still be
touched at all," and every route below already calls it before its ledger
write. Automatic postings piggyback on that existing gate rather than
adding a second, stricter one that could block a legitimate real-time
event. **Flagging for sign-off alongside Part 1** — it's a real behavior
choice, just a narrower one.

### 2.5 Expense-category accounts are dynamic, not fixed

Unlike the fixed `MAPPING_KEYS` set, an expense category is user-created
and open-ended (`expense_category:<categoryId>`), so there's no seed data
to rely on. **Recommendation**: auto-provision the mapping the first time
a category is actually paid, inside the same transaction — create a new
`chart_of_accounts` row (type `expense`, name = the category's own name,
code assigned from a reserved 5200+ block per the matrix) and its
`account_mappings` row, then use it immediately. This means a restaurant
can add expense categories freely without ever needing to visit the
Accounting screen first, at the cost of the Chart of Accounts growing
accounts it didn't explicitly create — each auto-creation gets its own
`recordAuditLog` entry (`action: "accounting.account_auto_created"`) so
it's traceable, and the account is ordinary afterward (editable/
deactivatable like any other, subject to 2.3's new guard). **Alternative**:
require a human to map every category via the Chart of Accounts screen
first, and throw a clear, actionable error otherwise. Simpler to reason
about, but means a restaurant that enables automatic posting and then adds
one new expense category next month has a payment silently fail (well,
loudly fail — the transaction rolls back) until someone visits a screen
they may not know exists. **Recommend auto-provisioning**; flagging as a
decision, not assuming.

---

## Part 3 — The slices, in build order

Each slice is independently shippable and independently tested — full
`tsc`/`eslint`/`vitest`/`build` plus a live smoke test after each one, per
the plan's own Part 4 checklist. Order matches the matrix's own
recommendation (sales first, the highest-value and highest-traffic path).

### Slice 4a — Sales + COGS (order completion)

**File**: `src/app/api/restaurants/[slug]/orders/[orderId]/status/route.ts`,
the `targetStatus === "completed"` block (currently lines 213–241), right
after the existing `recordSalesLedgerEntry` call — same transaction, same
`row` (the already-updated order, which has `subtotalInPaisa`,
`discountInPaisa`, `serviceChargeInPaisa`, `taxInPaisa`, `totalInPaisa`,
`branchId`, `customerId` all available with no extra query).

**New work inside that block, gated on `automaticPostingEnabled`:**

1. Load every `payments` row for this order so far (one query,
   `orderId` + `restaurantId`) and group by `method`, summing
   `amountInPaisa` and `tipInPaisa` per method — this is the existing
   `payments` table, no schema change.
2. Sum `orderItems.recipeCostInPaisa` for this order's items (`NULL`
   treated as 0/excluded, matching `getCogsSummary`'s own convention —
   `deductRecipeStockForOrder` already froze this value at the
   `confirmed → preparing` transition earlier in this same order's
   lifecycle, so it's reliably populated by completion time for every item
   that has a recipe).
3. `resolveAccountMappings` for: the four payment-method keys actually
   used (only the ones with a nonzero grouped total — an order paid
   entirely in cash never touches the clearing accounts), `ACCOUNTS_RECEIVABLE`,
   `DISCOUNTS_AND_ALLOWANCES`, `SALES_REVENUE`, `SERVICE_CHARGE_REVENUE`,
   `TAX_PAYABLE`, `TIPS_PAYABLE` (only if any payment recorded a tip),
   `COST_OF_GOODS_SOLD`, `INVENTORY` (only if step 2's sum is nonzero).
4. `postVoucher(tx, { voucherType: "sales", branchId: row.branchId,
   voucherDate: today (restaurant timezone), sourceType:
   "order_completion", sourceId: row.id, postingEvent: "sale", lines: [...] })`
   — built exactly per the matrix's §1 table: one Dr line per payment
   method with a nonzero grouped total, one Dr line to Accounts Receivable
   for `totalInPaisa` minus the sum of those payments (tagged
   `customerId: row.customerId` if present), one Dr line to Discounts &
   Allowances for `discountInPaisa` (only if nonzero), Cr Sales Revenue for
   `subtotalInPaisa`, Cr Service Charge Revenue for `serviceChargeInPaisa`
   (only if nonzero), Cr Tax Payable for `taxInPaisa` (only if nonzero), Cr
   Tips Payable for the summed tip total (only if nonzero). Zero-amount
   lines are omitted rather than posted as zero, since `postVoucher()`
   itself rejects a line where neither side is positive.
5. If step 2's COGS sum is nonzero, a **second** `postVoucher()` call in
   the same transaction: `postingEvent: "cogs"` (same `sourceType`/
   `sourceId` as the sale, different event so the idempotency key doesn't
   collide, exactly as the matrix's §6 specifies) — Dr Cost of Goods Sold,
   Cr Inventory, both for that sum.

**Existing behavior this must not change**: everything above the new block
(loyalty points, fiscal invoice numbering, table status sync,
`recordSalesLedgerEntry` itself) stays exactly as-is — Account Books
keeps writing in parallel with the new voucher engine, per the plan's own
"`ledger_entries` stops being written to once Phase 4 integrations land"
being a Phase 5+ cleanup step, not part of this slice.

**Test plan**: extend `accounting-posting.test.ts`'s sibling
(`accounting-integration-sales.test.ts`, new) with real order fixtures —
cash-only order, split cash+card order, fully-on-credit order (zero
payments at completion), order with a discount, order with a tip, order
with recipe-costed items — asserting the exact voucher lines and totals
per the matrix's own worked example, plus one test with automatic posting
disabled proving zero vouchers are created and the existing behavior is
byte-for-byte unchanged.

### Slice 4b — Payment settlement & refunds (post-completion)

**File**: `src/app/api/restaurants/[slug]/orders/[orderId]/payments/route.ts`,
right after the `payments` insert (currently line 191), inside the same
`db.transaction`. **Only fires when `order.status === "completed"`** — a
payment recorded against a not-yet-completed order is already correctly
folded into slice 4a's Sales Voucher once that order completes, so posting
here too would double-count it. `postVoucher(tx, { voucherType: "payment",
sourceType: "payment_settlement", sourceId: payment.id, postingEvent:
"settlement", lines: [Dr <method clearing account>, Cr Accounts
Receivable (tagged order.customerId)] })` per the matrix's §2.

**File**: `src/app/api/restaurants/[slug]/orders/[orderId]/refunds/route.ts`,
right after the refund insert (currently line 199), unconditional (a
refund can happen whether or not the order is still "completed").
`postVoucher(tx, { voucherType: "refund", sourceType: "refund", sourceId:
refund.id, postingEvent: "refund", lines: [...] })` per §2.

**Open decision — the tip-refund split doesn't exist in today's data.**
The matrix's §2 refund table has a conditional line ("Dr Tips Payable,
only if the tip portion is also being refunded"), but
`recordRefundSchema`/the `payments` table have no field distinguishing "of
this Rs 500 refund, Rs 50 was tip" — a refund is just one signed amount
plus a method. Until that's added (a small, separate schema/UI change,
arguably its own tiny slice), this integration will book the **entire**
refund amount to Sales Returns & Refunds and never touch Tips Payable —
which is simply the correct treatment for the common case (refunding the
bill, not the tip) and only wrong for the rarer case a tip refund is
mixed into the same request. Flagging this as a known, documented
limitation rather than silently guessing at a split; can be tightened
later without touching the posting logic itself, only the input it's
given.

**Combine bill**: confirmed in the matrix (§3) and re-confirmed here after
reading `recordCombinedPayment` — it inserts ordinary `payments` rows, one
per order, so slices 4a/4b's own hooks fire naturally per order with no
new code needed for this path specifically.

**Test plan**: settlement after a fully-on-credit order completes (AR
should reach zero); a straight refund against a same-day cash sale; a
refund against an order from a previous day; combine-bill settling two
orders in one call, verifying two separate settlement vouchers with
correct per-order `sourceId`s.

### Slice 4c — Purchases + supplier payment settlement

**File**: `src/app/api/restaurants/[slug]/purchases/route.ts`, right after
the existing `recordPurchaseLedgerEntry` call (currently line 230), same
transaction. `postVoucher(tx, { voucherType: "purchase", sourceType:
"purchase", sourceId: purchase.id, postingEvent: "purchase", lines: [Dr
Inventory for totalInPaisa, Cr Accounts Payable (tagged supplierId) if
isCredit else Cr <?>] })` per §4.

**Open decision — no payment-method field on an immediate (non-credit)
purchase.** `purchases` has `isCredit` but nothing recording *how* a
non-credit purchase was paid (cash from the till? bank transfer?) — the
matrix's own §4 says "Cash on Hand / Bank," leaving the choice open, but
today's schema can't distinguish them. **Recommendation**: default every
immediate purchase to Cash on Hand for this slice (matches the fact that
most small-restaurant stock-in purchases in this market are paid from the
till), and treat "purchases paid by bank transfer" as a Phase 5 follow-up
once Bank Accounts exist and a `paymentMethod` field can be added
alongside them — adding a whole new field + UI control to the Purchases
form is more surface area than this slice needs to unblock the Accounts
Payable side, which is the actually novel part. Flagging for sign-off.

**Files**: `.../ledger/[entryId]/settle/route.ts` (generic due
settlement, used for both AR and AP today via `settleLedgerDue`),
`.../suppliers/[supplierId]/payments/route.ts` (lump-sum supplier payment
via `recordSupplierPayment`) — both need a mirror of §4's "supplier
payment" row (Dr Accounts Payable tagged `supplierId`, Cr Cash on
Hand/Bank). Since `recordSupplierPayment`/`settleLedgerDue` can settle
several underlying `ledger_entries` rows in one call (oldest-first
allocation), the cleanest accounting mirror is **one voucher for the total
amount actually applied**, not one per underlying ledger entry — the
accounting side doesn't need the same per-entry granularity Account Books
does, since AP aging in this module is meant to come from
`accounting_voucher_lines.supplier_id`/`customer_id` tags directly (per
the plan's own account-scoping section), not from mirroring
`ledger_entries`' row shape one-to-one.
`.../customers/[customerId]/credit/settle/route.ts` (`settleCustomerCredit`,
the customer-side lump-sum equivalent) gets the same treatment for AR.

**`recordSupplierAdjustment`** (manual credit/debit notes against a
supplier, outside the purchase flow) has no corresponding row in the
posting matrix at all — it's a newer feature than the matrix's own last
revision. **Recommendation**: leave it un-integrated in this phase
(it keeps writing to `ledger_entries` only, same as today) and treat
"manual AP adjustments in the new ledger" as a Phase 5 item alongside the
AR/AP aging rework the plan already schedules there, rather than
retrofitting a posting rule the matrix was never reviewed against.
Flagging as a scope note, not asking for a decision — recommending
deferral outright.

**Test plan**: a cash purchase, a credit purchase, a partial supplier
settlement (two payments against one purchase), a lump-sum multi-purchase
supplier payment, the customer-credit mirror for AR.

### Slice 4d — Expenses

**Three call sites**, all in `src/lib/ledger.ts`'s two functions
(`recordExpenseLedgerEntry` used at direct-pay creation and at the `pay`
route; `reverseExpenseLedgerEntry` used at void):

- `src/app/api/restaurants/[slug]/expenses/route.ts`, the `if (status ===
  "paid")` block (currently lines 250–261).
- `src/app/api/restaurants/[slug]/expenses/[expenseId]/pay/route.ts`,
  right after its own `recordExpenseLedgerEntry` call (currently line 111).
- `src/app/api/restaurants/[slug]/expenses/[expenseId]/route.ts`, both
  branches of the `togglingVoid` block (currently lines 174–195) — void
  calls `reverseExpenseLedgerEntry`, un-void calls `recordExpenseLedgerEntry`
  again.

Each gets a matching `postVoucher()` call in the same transaction, right
next to its existing ledger call: `voucherType: "expense"`, `sourceType:
"expense_payment"`, `sourceId: expense.id`, `postingEvent: "paid"` (or
`"voided"` for the reversal — using `reverseVoucher()` against the
original posted voucher rather than a hand-built mirror voucher, so the
reversal is guaranteed to be the exact opposite of what was actually
posted, and the original is marked `reversed` rather than left ambiguous).
Lines per §5: Dr the category's mapped expense account (resolved per 2.5
above, auto-provisioning if new), Cr the mapped clearing account for
`paymentMethod`.

**Open decision — expense payment methods vs. the mapping keys that
exist.** Need to confirm `EXPENSE_PAYMENT_METHODS` (the expense-specific
payment-method list) lines up 1:1 with the four `PAYMENT_METHOD_*` mapping
keys — if expenses allow a method the mapping table doesn't cover (e.g. a
generic "bank transfer" distinct from "card"), that method needs either a
new mapping key or a fallback account before this slice can post
correctly for it. This is a quick verification, not a design question —
called out here so it's checked during implementation, not assumed.

**Test plan**: direct-pay expense creation, the two-step approve-then-pay
flow, void of a paid expense (reversal), un-void, an expense category with
no existing mapping (proving auto-provisioning per 2.5 works and is
audit-logged).

### Slice 4e — Payroll (cash-basis, per the matrix's own recommendation)

**Confirm the cash-basis-first decision explicitly before this slice
starts** — the matrix flags it as the one open policy question, and
recommends cash-basis (matches today's only behavior, zero new triggers)
while noting accrual is a legitimate Phase 5+ alternative. This plan
follows that recommendation; restating it here as the point where it
actually needs to be locked in, since this is the slice it blocks.

**Two call sites**, both already calling into
`recordPayrollLedgerEntry`/`reversePayrollLedgerEntry`:

- `src/app/api/restaurants/[slug]/payroll/payments/route.ts`, right after
  its own call (currently line 194).
- `src/app/api/restaurants/[slug]/payroll/payments/[paymentId]/route.ts`
  (void), right after its own call (currently line 102), using
  `reverseVoucher()` against the original, same reasoning as expenses'
  void path.

`voucherType: "payroll"`, `sourceType: "payroll_payout"`, `sourceId:
payrollPaymentId`, `postingEvent: "paid"`/`"voided"`. Lines (cash-basis):
Dr Salary Expense, Cr Cash on Hand/Bank — for the full `amountInPaisa`.

**Open decision — no payment-method field on a payroll payment either**,
same shape as purchases' gap. **Recommendation**: default to Cash on Hand
here too, same rationale (most payroll payouts in this market are cash),
revisit alongside Bank Accounts in Phase 5.

**The name-redaction discipline must carry over.** `recordPayrollLedgerEntry`'s
own doc comment is explicit about never putting a staff member's name in
its description, because `MANAGE_ACCOUNT_BOOKS` (held by `manager`) is
deliberately not paired with `VIEW_PAYROLL`. The new voucher's `narration`
field must follow the exact same rule — generic ("Staff salary payment —
August 2026"), never a name — and this needs a matching RBAC check: does
a `manager` (who'd hold the new `MANAGE_ACCOUNTING` permission once it's
granted similarly broadly) end up able to see a payroll voucher's
*narration* in the Day Book/Ledger Accounts screens without also holding
`VIEW_PAYROLL`? Since narration is restaurant-wide (not per-permission
redacted at read time the way this codebase handles other splits), the
safe answer is the same one `recordPayrollLedgerEntry` already chose:
keep the narration itself generic enough that seeing it leaks nothing,
rather than trying to filter it per-viewer.

**Test plan**: a payroll payout, a void, confirming the voucher's
narration never contains a staff name even when the payment itself does.

### Slice 4f — Reconciliation → bank settlement

**File**: `src/lib/financial-reconciliation.ts`'s `markPaymentReconciled`
(currently lines 239–260) and `unmarkPaymentReconciled` (lines 269–288) —
these are the actual choke points (both existing API routes,
`.../reconciliation/[paymentId]/mark` and `.../unmark`, already call
through them), so the new `postVoucher()` calls belong inside these two
functions themselves, not duplicated in both routes.

`voucherType: "contra"`, `sourceType: "payment_reconciliation"`,
`sourceId: paymentId`, `postingEvent: "reconciled"` — Dr Bank Account, Cr
the clearing account matching the payment's own `method` (per §9; cash is
structurally excluded already, since `assertReconcilableMethod` already
rejects it before this point). Unmark reverses via `reverseVoucher()`.

**Depends on Phase 5's Bank Accounts existing** in some minimal form
before this slice can actually post (there's no Bank Account row/mapping
key yet — `MAPPING_KEYS` has no `BANK_ACCOUNT` entry, and the matrix's own
chart-of-accounts table lists "1040 Bank Account(s)" as "Phase 5").
**Recommendation**: land slices 4a–4e first, and treat 4f as the trigger
to pull the minimum viable slice of Phase 5 (one default Bank Account row
+ mapping key, not the full bank-reconciliation UI) forward just enough to
unblock this one posting — rather than either blocking all of Phase 4 on
Phase 5, or skipping this slice indefinitely. Flagging as a sequencing
call, not asking to resolve it now.

---

## Part 4 — Explicitly NOT part of Phase 4

- **Cash Register movements** — per the matrix's §7 and an earlier
  decision in this engagement, deliberately never auto-posted. No change.
- **Owner capital/drawings** — manual Journal Voucher only (already
  possible since Phase 2). No new code.
- **`recordSupplierAdjustment`** — deferred to Phase 5, per Slice 4c's own
  note above.
- **Tax engine, AR/AP aging, Fixed Assets, Bank reconciliation UI, Cash
  Flow** — all explicitly Phase 5/6 per the original plan; nothing here
  changes that sequencing.
- **Migrating or backfilling historical `ledger_entries`** — still not
  happening, per the plan's clean-cutover decision. Every voucher in this
  phase is for a NEW event from the moment each slice ships; nothing
  retroactive.

---

## Part 5 — Open decisions needing sign-off before code starts

1. **The opt-in gate itself** (Part 1) — a new `automaticPostingEnabledAt`
   column + an explicit "Enable automatic posting" action, separate from
   merely seeding the chart of accounts.
2. **Automatic postings always bypass the accounting-period lock**
   (`allowClosedPeriod: true` unconditionally — Part 2.4), relying on the
   existing daily-close lock as the real gate.
3. **Auto-provisioning expense-category accounts on first use** (Part 2.5)
   vs. requiring a human to map them first.
4. **Tip-refund splitting is out of scope for this phase** (Slice 4b) —
   full refund amount always books to Sales Returns & Refunds.
5. **Immediate (non-credit) purchases default to Cash on Hand** (Slice 4c)
   until a real payment-method field exists (Phase 5, alongside Bank
   Accounts).
6. **Payroll payouts default to Cash on Hand** (Slice 4e), same reasoning
   as #5.
7. **Cash-basis payroll, confirmed** (Slice 4e) — restating the matrix's
   own recommendation as the point it needs to actually be locked in.
8. **Reconciliation (Slice 4f) waits on a minimal Bank Account** being
   pulled forward from Phase 5, rather than blocking the rest of Phase 4
   or being skipped indefinitely.

None of these block Slice 4a specifically except #1 and #2, which every
slice depends on — those two are the ones most worth deciding first.

---

**Where this leaves things:** nothing has been built. This is the
plan-before-code Phase 4 itself calls for. Once Part 5's decisions are
confirmed (or amended), the recommended next step is Slice 4a alone —
sales + COGS at order completion — reviewed and fully verified on its own
before Slice 4b starts, exactly matching how every prior phase in this
engagement has been handled.
