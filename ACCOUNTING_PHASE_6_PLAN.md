# Accounting Module — Phase 6 Implementation Plan (Tax and Compliance)

Status: **research + planning only — no schema or code changes made yet.**
Same discipline as every prior phase's own plan in this engagement: this is
reviewed before any of it lands, as a whole or slice by slice, and per
`ACCOUNTING_MODULE_PLAN.md`'s own flag on this phase — *"Do not claim
Nepal-specific legal compliance without verifying the current Nepal
tax/VAT requirements. This phase needs actual research into current
Nepali VAT rules before any hard behavior is built, not an assumption
carried over from general accounting knowledge."*

## Part 0 — How this plan was grounded, and its limits

Every Nepal-specific legal/tax claim below was checked against a live web
search done this session (not carried over from training data), and cross-
checked across multiple independent sources wherever a number could
plausibly be wrong or out of date — see the Sources section at the end.
Two things to flag plainly before anything else:

1. **Nepal's Finance Act changes VAT/tax thresholds and rates most fiscal
   years** (the fiscal year runs mid-July to mid-July; today is early in
   FY 2083/84). Everything numeric below reflects what current web sources
   report for FY 2082/83–2083/84, but a threshold or rate is exactly the
   kind of fact that can move on the next budget announcement. **None of
   this should be hard-coded as an assumed-permanent constant** — see Part
   3's own recommendation that every number here be a restaurant-editable
   setting, not a literal in code.
2. **The sources for VAT registration thresholds genuinely disagreed with
   each other**, and one number below could not be fully reconciled — see
   Part 2.1's own explicit callout. Where sources disagreed, this plan
   states the disagreement rather than picking a side, and recommends
   verifying with a licensed Nepali chartered accountant or the Inland
   Revenue Department (IRD) directly before any registration-threshold
   number is presented to a restaurant owner as authoritative.

This plan does not, and cannot, substitute for that professional
verification — it exists to scope what Phase 6 should build assuming the
numbers are confirmed, not to certify the numbers itself.

---

## Part 1 — What already exists in this codebase today

Reading the actual code before planning any of this surfaced more prior
art than the original module plan's one-line Phase 6 description implied:

### 1.1 Output VAT is already collected and posted — per order, automatically

Every menu item already has its own `taxRateBasisPoints` (0–10000, i.e.
0–100%, `src/db/schema.ts`), and `computeOrderPricing` (`orders.ts`)
already computes a real `taxInPaisa` per order, per line item, today —
this is Phase 1/2 functionality, nothing Phase 6 needs to build. Phase 4's
`postSaleAndCogsVouchers` (`integrations/order-completion.ts`) already
posts that collected tax to the seeded **"2100 Tax Payable"** liability
account (`MAPPING_KEYS.TAX_PAYABLE`) whenever `taxInPaisa > 0` on a sale.
In double-entry terms, Output VAT already has a real, correct home in the
ledger — a VAT return's "output tax" figure for a period is already
sitting in 2100's own balance for that period, right now, with zero new
code.

### 1.2 PAN/VAT registration numbers are already stored

`src/app/api/restaurants/[slug]/tax-settings/route.ts` already lets an
owner record their PAN and VAT registration numbers (`panNumber`/
`vatNumber` columns on `restaurants`) — described in its own comment as a
"Gap-audit P2 fix (fiscal compliance)." This is display/record-keeping
only (used on printed bills/invoices), not tied to any VAT computation or
threshold logic today.

### 1.3 What's genuinely missing

- **Input VAT tracking.** `integrations/purchases.ts` posts a purchase's
  full cost straight to Inventory/COGS-side accounts — there is no
  separate "VAT paid on this purchase" line, no Input VAT account, and
  nothing distinguishing a VAT-registered supplier's invoice from one
  that isn't. A restaurant that's VAT-registered is entitled to credit
  input VAT against output VAT; this codebase currently has no mechanism
  to even record that a purchase included VAT, let alone credit it.
- **Tax rates are single-value and per-menu-item, not effective-dated.**
  `taxRateBasisPoints` is one live number per item with no history — if a
  rate changes (the standard rate itself, or a per-item override), there
  is no record of what rate applied to a past sale beyond whatever was
  already baked into that historical `taxInPaisa` figure. The original
  module plan's own Phase 6 line item — "configurable `tax_rates`
  (effective-dated, per §20)" — is not built.
- **No VAT return / tax summary report.** Nothing today computes "output
  tax collected minus input tax credit = net VAT payable for this
  period," the actual return figure a restaurant would file with the IRD.
- **No credit/debit notes.** A sales return or a price correction after
  invoicing has no dedicated voucher shape yet (Slice 4a's own refund
  voucher type covers a cash refund, but not a formal VAT-compliant
  credit note reducing a specific prior invoice's own output tax).
- **No Nepal tax depreciation.** Slice 5d (Phase 5) deliberately built
  only straight-line, book-purposes depreciation and explicitly deferred
  "does this need to match a specific Nepali tax depreciation schedule"
  to this phase (see that slice's own report). Nepal's actual income-tax
  depreciation method (Part 2.2 below) is a **pooled declining-balance**
  system, structurally different from straight-line — if a restaurant
  needs its tax return's depreciation figure, that's a second, parallel
  computation, not a variant of Slice 5d's existing one.
- **No TDS (Tax Deducted at Source).** Nepal's Income Tax Act also
  requires withholding tax at source on many payments (staff salaries,
  certain supplier payments, rent, etc.) — nothing in payroll or expenses
  computes or tracks this today. This is a real, separate compliance
  surface, but it is outside the module plan's own stated Phase 6 scope
  (which is VAT-focused); flagged here as a genuine future-phase
  candidate, not silently rolled into this phase.

---

## Part 2 — Researched facts, with sources

### 2.1 VAT — rate, registration, filing, invoicing

- **Standard VAT rate: 13%**, unchanged since VAT's introduction in 1997,
  applied uniformly across goods and services (no reduced-rate tier).
- **Registration thresholds** (the number three of four sources agree on):
  **NPR 50 lakh (5,000,000) annual turnover for goods-only** businesses;
  **NPR 30 lakh (3,000,000) for services-only or mixed goods+services**
  businesses — a restaurant selling food and drink is a mixed/services
  business, so the 30 lakh figure is the relevant one for an ordinary
  restaurant. **One source (Wakil Nepal) gave a materially different
  services threshold (NPR 1,000,000)** that could not be reconciled with
  the other three — this plan does not resolve that discrepancy and flags
  it as something to verify directly with the IRD or an accountant before
  encoding any hard number.
- **A restaurant "with a bar" (serving alcohol) must register for VAT
  immediately, regardless of turnover** — alongside liquor/tobacco
  manufacturers and distributors and several other named sectors. An
  ordinary restaurant with no bar/liquor service is NOT automatically
  exempt from the threshold rule by virtue of being a restaurant — it's
  specifically alcohol service that triggers mandatory registration.
  (An earlier, less precise source claimed all "hospitality
  establishments" must register from first sale — the more specific,
  better-corroborated finding is that it's the bar/alcohol angle
  specifically, not the restaurant category as a whole.)
- **Filing is monthly by default** (due the 25th of the following Nepali
  month); **hotels and some restaurant operations may qualify for
  trimester (four-monthly) filing**, but this requires explicit IRD
  approval — it is not automatic just for being a restaurant.
- **VAT invoices must show**: supplier name, VAT registration number,
  customer details, description of items, the VAT amount itemized, and an
  invoice serial number.
- **Common VAT-exempt basic food items** include rice, pulses, flour,
  fresh fish and meat, eggs, vegetables, fruits, edible oil, and fresh
  milk — relevant if a restaurant also runs any retail/grocery side, less
  relevant to prepared restaurant meals themselves (which are a taxable
  service), but worth knowing if any menu item is really an unprocessed
  exempt good being resold.

### 2.2 Income tax depreciation — Schedule 2, Income Tax Act 2058

Nepal's Income Tax Act uses a **pooled declining-balance** method, not
straight-line — structurally different from Slice 5d's book depreciation:

| Pool | Assets | Annual rate |
|---|---|---|
| A | Buildings, structures, and other permanent structures | 5% |
| B | Computers, data-processing equipment, furniture, fixtures, office equipment | 25% |
| C | Automobiles, buses, minibuses | 20% |
| D | Construction/excavation equipment and any depreciable property not listed elsewhere | 15% |
| E | Intangible assets | cost ÷ useful life, rounded to the nearest half-year (not pooled) |

Depreciation is computed on each pool's **aggregate balance**, not per
individual asset — an addition and a disposal within the same pool net
together before applying the rate. A mid-year acquisition gets a
fractional first-year rate (roughly thirds, based on which third of the
year it was acquired in) rather than day-count proration. Certain
infrastructure/specified entities get a one-third enhancement to the
Pool A–D rates — almost certainly not relevant to an ordinary restaurant,
noted for completeness.

### 2.3 Interest deduction — Section 14, Income Tax Act 2058

Interest on business debt is deductible when the borrowed funds were used
productively for income-generating business activity in that year — this
covers an ordinary restaurant's loan the way Slice 5e already models it
(a real loan, real interest expense). The Act's own restriction (interest
deduction capped against a controlled tax-exempt entity's income) applies
only to entities **controlled by a tax-exempt organization** (≥25%
ownership/control by a tax-exempt body, an associate, or a non-resident) —
this does not describe an ordinary privately-owned restaurant business, so
it's very unlikely to be a real constraint for this product's actual
users. Flagged for completeness, not recommended as something to build a
feature around.

---

## Part 3 — What Phase 6 should build, sliced

Following the same "small, reviewable slices" discipline as Phase 5,
proposed order:

### 6a — Input VAT tracking on purchases

Add an optional "this purchase included VAT" path to
`integrations/purchases.ts`: when a supplier invoice is VAT-registered,
split the posted amount into the goods/service cost and a new **"1080
Input VAT"** (or similar) receivable-side asset account, rather than
folding the VAT into inventory/COGS cost. Lowest-risk slice — purely
additive to an existing integration, no new voucher type needed (the
purchase voucher just gains an optional third line).

### 6b — Effective-dated tax rate configuration

Address the module plan's own original Phase 6 line item: a `tax_rates`
table (rate, effective-from date, optionally a category/item scope) so a
rate change doesn't retroactively reinterpret history, and so this
module has an actual auditable record of "what rate applied when" instead
of relying on whatever number happened to be baked into each historical
`taxInPaisa`. Needs a decision (Part 5, #1) on whether this replaces or
layers on top of the existing live `taxRateBasisPoints` field.

### 6c — VAT return / tax summary report

A read-only report: output tax (2100's activity for the period, mirroring
how Slice 5c's Cash Flow Statement already reads voucher activity for a
period) minus input tax (6a's new account), producing the net-payable
(or net-refundable) figure a restaurant would use to fill out its actual
IRD return. Explicitly a **summary for the owner's own reference**, never
a claim of being a filable/submittable government form.

### 6d — Credit/debit notes

A dedicated voucher shape for a formal post-invoice correction (a sales
return, or a price adjustment) that reduces the original invoice's own
output tax figure correctly — distinct from Slice 4a's existing cash
refund voucher, which handles the cash-flow side but not a VAT-compliant
credit note's own paper trail.

### 6e — Nepal tax depreciation (pooled declining-balance), as a parallel report

Per Part 2.2: build this as a **second, independent computation**
alongside Slice 5d's existing straight-line book depreciation, never a
replacement or a "toggle" on the same `fixed_assets` table — the two
methods answer different questions (book value for management vs. a tax
return's own depreciation claim) and conflating them risks corrupting
whichever one is trusted less carefully. Concretely: pool assets by
Part 2.2's five categories, track each pool's own aggregate balance,
apply the fixed declining-balance rate. This can reuse Slice 5d's own
`fixed_assets` rows as its input (mapping each asset to a Part-2.2 pool)
without touching that table's own book-depreciation fields at all.

---

## Part 4 — Explicitly NOT part of Phase 6

- **TDS (Tax Deducted at Source)** — a real, separate compliance surface
  (Part 1.3) but outside the module plan's own stated scope for this
  phase; a future-phase candidate.
- **Any direct e-filing / API integration with the IRD** — nothing in
  this plan assumes or requires connecting to a government system; every
  report here is for the owner's/accountant's own reference.
- **Enforcing a VAT-registration threshold as a hard gate** (e.g. blocking
  a restaurant from operating, or nagging them, once turnover crosses a
  number) — given the sourced disagreement in Part 2.1, this product
  should surface numbers as informational, never as an authoritative
  compliance determination it makes on the owner's behalf.
- **Thin-capitalization / controlled-entity interest restrictions**
  (Part 2.3) — doesn't describe this product's actual restaurant-owner
  users.

---

## Part 5 — Open decisions needing sign-off before code starts

1. **Does 6b's effective-dated `tax_rates` table replace the existing
   live `taxRateBasisPoints` field on menu items, or layer on top of it**
   (menu items keep a live "current rate" for fast lookups, while
   `tax_rates` becomes the audit trail of what changed when)? Layering is
   lower-risk (no migration of existing menu-item data, no change to the
   POS's own fast-path pricing lookup) but means two places store
   "the rate," which needs a clear single-source-of-truth rule.
2. **Should a restaurant have an explicit "serves alcohol / has a bar"
   flag** (per Part 2.1's mandatory-registration finding), surfaced
   somewhere in Settings, purely as an informational prompt ("you may
   need to register for VAT regardless of turnover — verify with the
   IRD/an accountant") — or is that out of scope for this product
   entirely, leaving registration timing wholly up to the owner?
3. **Build order for 6a–6e** — 6a (Input VAT) and 6c (VAT return report)
   are natural companions (6c needs 6a's data to be a real net-payable
   figure) and are recommended first; 6b (effective-dated rates) and 6d
   (credit/debit notes) are independent and can come in either order;
   6e (Nepal tax depreciation) has the least code-reuse with the rest and
   could be built anytime once 5d's `fixed_assets` table exists, which it
   already does.
4. **Verify Part 2.1's disputed services-registration threshold (and
   every other number in this plan) against the IRD directly, or with a
   licensed Nepali chartered accountant, before it appears anywhere in the
   product as more than an editable, clearly-sourced default** — this is
   the one decision that isn't really this engagement's to make at all.

---

**Where this leaves things:** nothing has been built. Per the same pattern
as every prior phase, the recommended next step — once Part 5's decisions
are confirmed or amended — is 6a alone (Input VAT tracking), the
lowest-risk and most additive piece, reviewed and fully verified on its
own before the rest of Phase 6 starts.

---

## Sources

- [Schedule-2: Assessment of Depreciation Deduction — Income Tax Act, 2058 (2002)](https://actnepal.com/en/schedule/2/0/assessment-of-depreciation-deduction)
- [Section 14: Interest Deduction — Income Tax Act, 2058 (2002)](https://actnepal.com/en/section/202/0/section-14-interest-deduction-of-income-tax-act-2058-2002)
- [Value Added Tax Act, 2052 (1996) — actnepal.com](https://actnepal.com/en/act/3/2/value-added-tax-act-2052-1996)
- [VAT in Nepal 2082/83 (2026): Rates, Thresholds & Returns — Law Alpine](https://lawalpine.com/blog/vat-in-nepal-rates-and-thresholds-2082-83)
- [VAT in Nepal 2026: Rate (13%), Registration Threshold, Exempt Items & How It Works — DIY a VISA](https://diyavisa.com/vat-nepal-2026/)
- [VAT in Nepal: Registration, 13% Rate & Filing 2026 — Wakil Nepal](https://www.wakilnepal.com/articles/vat-registration-filing-nepal)
- [Threshold Limit for VAT Registration in Nepal — eStartup Nepal](https://estartupnepal.com/article/threshold-limit-for-vat-registration-in-nepal)
- [VAT Registration Nepal Turnover Threshold Process — Attorney Nepal](https://www.attorneynepal.com/blog/vat-registration-nepal-turnover-threshold-process)
