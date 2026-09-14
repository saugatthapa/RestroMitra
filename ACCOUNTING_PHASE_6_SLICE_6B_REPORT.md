# Accounting Phase 6, Slice 6b — Effective-Dated Tax Rate Configuration

## What was built

Before this slice, a menu item's tax rate (`menuItems.taxRateBasisPoints`) was a single live number with no history — changing it silently overwrote whatever number was there before, with no record of what the rate used to be or when it changed. Per `ACCOUNTING_PHASE_6_PLAN.md` Part 3's 6b and Part 5's open decision #1, this slice adds an auditable, effective-dated history of every tax-rate change, **layered on top of** the existing live field rather than replacing it (per sign-off):

- A new `menu_item_tax_rate_history` table is now the single source of truth for "what rate applied when."
- `menuItems.taxRateBasisPoints` stays exactly as it was — a fast, POS-readable cache — but it is now a *derived* value: every write to it goes through one function, `recordTaxRateChange`, which is the only thing allowed to touch it. A route can no longer set the live rate directly.
- Every tax-rate change, starting from the moment a menu item is created, is now recorded. A menu item created today with a 13% rate gets a history row for that 13% dated today, not just a live field with no explanation of where the number came from.
- A menu item's own tax rate history is viewable in the menu editor ("View tax rate history"), and a change can optionally be backdated (e.g. "this rate actually took effect on the 1st, I'm just entering it today").

## The decision this slice needed, and how it was resolved

Part 5's open decision #1 asked whether the new effective-dated table should **replace** the existing live `taxRateBasisPoints` field, or **layer on top of it**. This was put to `AskUserQuestion` rather than decided unilaterally, since it's a real architectural fork with different risk profiles — replacing it means every tax-rate read (the POS's own fast pricing path in `orders.ts`/`combos.ts`) would need to resolve the rate from the history table on every order, while layering keeps that hot path completely untouched. The user selected **"Layer on top (Recommended)"**, with the explicit tradeoff noted: two places now conceptually "store" the rate, so the history table had to be built as the true source of truth and the live field as strictly a cache of it — never the reverse.

## A scope decision made without asking, and why

The plan's own phrasing ("effective-dated... a rate change doesn't retroactively reinterpret history") could be read as implying support for *scheduling* a future rate change to auto-apply on its effective date. This slice deliberately does **not** support that. Two things drove that call:

1. This codebase has an explicit, established convention against background jobs for periodic changes — `fixed-assets.ts`'s `run-depreciation` route is documented as "deliberately human-triggered... never a background cron." There is no cron/scheduler infrastructure to hook into.
2. Without one, a future-dated row would be silently invisible to the live cache on the day it becomes due — nothing would flip `taxRateBasisPoints` at midnight — which is a worse footgun than not offering the feature at all (an owner enters a future change, forgets about it, and the POS quietly keeps charging the old rate past the date they thought it changed).

So `effectiveFrom` must be today or a past date. A future-dated request is rejected with a clear error telling the owner to enter the change on the day it takes effect. This is a genuine scope boundary, not an oversight — it's called out explicitly in the code comments and here so it isn't mistaken for a bug later.

The plan also mentions "optionally a category/item scope." Research confirmed this codebase has no restaurant- or category-level tax rate today — tax rate is exclusively per-menu-item. This slice builds history at the level that actually exists (per-item); there is nothing broader to audit yet.

## A real bug this slice's own tests caught before shipping

The core correctness property of an effective-dated table is: a **backdated correction** — recording a rate change for a date that falls *before* an already-recorded, still-current later change — must never override the live cache with the older value. Example: rates of 13% (Jan 1) and 15% (Mar 1) already exist; a correction is entered today for "actually Feb 1 was 14%." The live rate must stay 15% (Mar 1 is still the most recent date that has passed), not drop to 14%.

The first version of `recordTaxRateChange` got this wrong: it resolved "the current rate" by finding the most recent row with `effectiveFrom <= the row just inserted`, instead of `<= today`. For an immediate change (the common case) those two dates are the same, so the bug was invisible in the two "happy path" tests written first — it only surfaced once the backdate-specific test was written and run, which is exactly why that test existed. Caught before commit, fixed by adding an explicit `asOfDate` parameter (the restaurant's own "today," supplied by the caller) distinct from `effectiveFrom` (the date the row itself records), and re-verified — see `src/lib/accounting/tax-rate-history.ts`'s own comment on `recordTaxRateChange` for the corrected logic and the worked example.

## What changed, file by file

- **`src/db/schema.ts`** — new `menu_item_tax_rate_history` table: `id`, `restaurantId`, `menuItemId`, `taxRateBasisPoints`, `effectiveFrom` (a `date`, matching how every other date-scoped column in this schema works, e.g. `accountingVouchers.voucherDate`), `createdByUserId`, `createdAt`. A unique index on `(menuItemId, effectiveFrom)` prevents two rows claiming the same effective date for the same item. The same non-negative/≤100% CHECK constraints as `menuItems.taxRateBasisPoints` are mirrored here. Added the corresponding Drizzle relations.
- **`src/lib/accounting/tax-rate-history.ts`** (new) — `recordTaxRateChange(tx, { restaurantId, menuItemId, taxRateBasisPoints, effectiveFrom, asOfDate, createdByUserId })`: inserts the history row, then resolves and writes whichever row is now the most recent one with `effectiveFrom <= asOfDate` into `menuItems.taxRateBasisPoints`. `getTaxRateHistory(tx, { menuItemId })`: full history, most recent effective date first.
- **`src/lib/validation/menu.ts`** — added optional `taxRateEffectiveFrom` to `updateMenuItemSchema` (structural date-string validation only; the "not in the future" business rule needs the restaurant's own timezone, so it lives in the route).
- **`src/app/api/restaurants/[slug]/menu-items/route.ts`** (create) — item creation now runs inside a transaction: the item is inserted, then `recordTaxRateChange` is called immediately with `effectiveFrom = asOfDate = today`, so a menu item's tax rate history starts at creation, never with an untracked initial value.
- **`src/app/api/restaurants/[slug]/menu-items/[itemId]/route.ts`** (update) — validates `effectiveFrom` isn't in the future (using the restaurant's own `restaurantDate`), rejects `taxRateEffectiveFrom` sent without `taxRatePercent`, and — when a tax-rate change is present — runs the update and `recordTaxRateChange` inside one transaction, then re-reads the item so the response reflects whatever rate `recordTaxRateChange` actually resolved to (which, per the backdate case above, may not be the value just submitted).
- **`src/app/api/restaurants/[slug]/menu-items/[itemId]/tax-rate-history/route.ts`** (new) — read-only history for one item, gated by the same `EDIT_MENU` permission that already governs viewing/editing that item's tax rate (deliberately not the separate, stricter, unrestricted-only `MANAGE_STAFF` audit log — this is a focused per-item lookup, not a cross-cutting activity feed).
- **`src/app/dashboard/menu/MenuManager.tsx`** — an optional "Tax change effective from" date field (only shown when editing an existing item, capped at today client-side), and a "View tax rate history" toggle that fetches and lists the item's own change history (date, rate, changed by).
- **`drizzle/0089_opposite_bedlam.sql`** — the new table, indexes, and constraints. Applied cleanly.
- **Tests**: `src/db/__tests__/accounting-tax-rate-history.test.ts` (new, 7 tests) — first-rate-on-creation syncs the cache; a later change becomes current; the backdate-correctness case (the one that caught the bug above); the unique-index rejection; per-item history isolation; DB-level CHECK constraints; cascade delete when the menu item is removed.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` on every touched file — clean.
- Targeted tests (the new file plus `check-constraints`, `menu-tenant-isolation`, `order-pricing`, `combos`, `tax-settings`) — 53/53 passing.
- Full `npx vitest run` — 1614/1622 passing. The 8 failures are the same pre-existing, unrelated baseline as Slice 6d's report (`push-branch-filtering.test.ts` environment flakiness, and a hardcoded-port mismatch in the payment-gateway callback test) — none touch menu items, tax rates, or accounting code.
- `npm run build` — succeeds cleanly.
- Dev-server smoke test: unauthenticated `GET`/`POST` on `/api/restaurants/[slug]/menu-items`, `PATCH` on a menu item, and `GET` on the new tax-rate-history route all return clean `401`/`400` — no crash, no stack trace leak.

## Deliberately out of scope

- **Scheduling a future rate change to auto-apply.** See above — this codebase's own "no background cron" convention, and the footgun a silent non-apply would create, ruled this out for now. A future slice could add it properly only alongside a genuine reconcile mechanism (most likely a human-triggered "apply due changes" action, mirroring `run-depreciation`'s own pattern) — not attempted here.
- **Restaurant- or category-level tax rates.** Doesn't exist in this codebase today; nothing broader to audit yet.
- **Editing or deleting a past history row.** A correction is made by inserting a new row for the corrected date, never by mutating an existing one — the audit trail is append-only by design. If a truly duplicate/erroneous entry needs removing, that's an admin/DB-level fix, not a product feature this slice exposes.
- **Surfacing tax rate history in the general restaurant-wide audit log.** The existing `recordAuditLog` call on a menu-item update still fires (capturing that a change happened), but the detailed per-change history lives in the dedicated table/route described above, not duplicated into `audit_logs`.

## What's next

Per `ACCOUNTING_PHASE_6_PLAN.md` Part 5 #3, the one remaining Phase 6 slice is **6e** (Nepal tax depreciation, pooled declining-balance) — it has the least code-reuse with the rest of Phase 6 and can be built anytime, since Phase 5's `fixed_assets` table it would build on already exists. It will need research into how it should coexist with Slice 5d's existing straight-line book depreciation (the plan is explicit that these must stay two independent computations, never a toggle on the same table) before implementation starts.
