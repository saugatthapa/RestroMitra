# Accounting Phase 7, Slice 7f — Tally-Compatible Export

## ⚠️ Read this before using this feature

**This export is generated strictly from Tally's own publicly documented
XML import format — it has not been tested against a real Tally install,
because none is reachable in this environment.** This was flagged from
the start as the riskiest item in Phase 7 (`ACCOUNTING_PHASE_7_PLAN.md`
§1.5/§2.6), and the plan explicitly recommended checking in with you
before or during this slice. Since your reply to that check-in was
"continue," I've built it exactly as the plan's fallback describes: to
the documented schema, with the caveat kept permanently visible in the UI
rather than removed later. **Please test it against a disposable Tally
company with a small date range before trusting it for a real books
migration** — see "Known limitations" below for the specific gaps most
likely to bite.

## What was built

A "Tally Export" report tab: a date range (and the header's branch
switcher, for a branch-scoped export), a preview showing how many
vouchers are ready and any that had to be skipped, and a download button
producing a Tally-import-ready XML file.

## How the XML format was actually verified (against documentation, not software)

Per the plan's own requirement — "researched via public documentation
rather than assumed from general knowledge" — I fetched Tally's own
Developer Reference ("Case Study 1 — XML Request and Response Formats,"
help.tallysolutions.com) and pulled its **complete, verbatim, balanced
worked example** rather than relying on a summary or a third-party
write-up:

```xml
<ALLLEDGERENTRIES.LIST>
  <LEDGERNAME>Conveyance</LEDGERNAME>
  <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
  <AMOUNT>-12000.00</AMOUNT>
</ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST>
  <LEDGERNAME>Bank of India</LEDGERNAME>
  <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
  <AMOUNT>12000.00</AMOUNT>
</ALLLEDGERENTRIES.LIST>
```

This mattered more than it might look: I found multiple secondary sources
disagreeing with each other and with this example on the AMOUNT sign
convention (one showed both debit and credit as positive; Tally's own
example clearly does not). Tally's own worked example — a debit that
nets to `-12000.00` paired with a credit at `12000.00`, summing to
zero — is unambiguous and is what this implementation follows: **debit →
`ISDEEMEDPOSITIVE=Yes` and a negative amount; credit →
`ISDEEMEDPOSITIVE=No` and a positive amount.** Getting this backwards
would have produced XML that looks plausible but silently inverts every
voucher on import — exactly the failure mode the plan warned about.

## Voucher-type mapping

| This app's voucher type | Tally voucher type | Why |
|---|---|---|
| `sales` | Sales | Direct match. |
| `purchase` | Purchase | Direct match. |
| `payment` | Payment | Direct match. |
| `expense` | Payment | Per the plan's own example mapping. |
| `refund` | Credit Note | `integrations/payment-settlement.ts`'s own narration already calls this "credit note — reduces output VAT." |
| `contra` | Contra | Direct match — Tally has a native Contra type for cash/bank transfers. |
| `journal`, `payroll`, `opening_balance`, `fixed_asset`, `depreciation`, `loan` | Journal | Tally has no default voucher type for any of these; a plain Journal is the standard, safe fallback for a capital/adjusting/payroll-summary entry that doesn't belong in Sales/Purchase/Payment/Contra. |

An unrecognized voucher type (a future addition to the enum this export
isn't updated for) also falls back to "Journal" rather than emitting
`undefined` — a defensive default, not a claim that it's the right Tally
type for whatever gets added later.

## Reused, not duplicated

Built on Slice 7c's `getJournalReport` rather than a fourth parallel
voucher/line query — this export can never disagree with what the
Journal report itself shows for the same period. This slice's own work is
purely the transformation layer: Tally's XML shape, the sign convention,
and the voucher-type mapping. Same "layer a transformation over an
existing generator" pattern Slice 7d's Inventory Valuation used over
Slice 7a's Cash Book.

## Known limitations (also shown in the UI, not just here)

- **Ledger names must match an existing Tally ledger by exact string.**
  Tally's XML import does not create missing ledgers unless the target
  company has "allow unknown ledgers" enabled — this export has no way to
  know that setting. If your Tally ledger names don't exactly match this
  app's account names, the import will fail or misfile.
- **AR/AP loses per-party granularity in Tally.** This schema's Accounts
  Receivable/Payable are single shared control accounts with a
  customer/supplier *tag* on each line (see `aging.ts`'s own design
  comment) — Tally's own convention is one ledger per debtor/creditor.
  Every AR/AP line in this export lands under one generic "Accounts
  Receivable"/"Accounts Payable" ledger; the party is still traceable in
  this app's own AR/AP Aging report, just not inside Tally.
- **`opening_balance` exports as a plain Journal voucher.** Tally's own
  convention is to set a ledger's opening balance as a field on the
  ledger *master*, not a voucher. This export only does a Vouchers-type
  import, not Masters, so this is a pragmatic (if slightly non-idiomatic)
  choice, not an oversight.
- **`payroll` does not use Tally's own Payroll feature.** That's a
  separate, materially different XML schema (employee/pay-head masters)
  — out of scope; this exports the same summary journal entry this app
  already posts internally.
- **A voucher whose lines don't balance is skipped, not exported.**
  `postVoucher()` should make this structurally impossible (Slice 7e's
  Health Check is where to investigate if one ever appears) — this export
  defends against it anyway rather than handing Tally something it would
  reject, and reports every skipped voucher number back in the preview so
  nothing silently vanishes from the count.

## What changed, file by file

- **`src/lib/accounting/tally-export.ts`** (new) —
  `getTallyExport({ restaurantId, fromDate, toDate, branchId? })`,
  returning `{ xml, fromDate, toDate, voucherCount, skippedVoucherNumbers }`.
- **`src/app/api/restaurants/[slug]/accounting/reports/tally-export/route.ts`**
  (new) — `GET`, gated `MANAGE_ACCOUNTING`. `?format=json` returns the
  lightweight preview; the default response is the actual XML file with
  `Content-Disposition: attachment`, matching this codebase's existing CSV
  export convention (`purchases/export/route.ts`).
- **`src/app/dashboard/accounting/AccountingBoard.tsx`** — new "Tally
  Export" report tab: a permanent amber caveat banner, a date range, the
  branch scope note, a JSON-preview count (with any skipped voucher
  numbers called out), and a plain `<a download>` link for the actual
  file — the same pattern this dashboard's other CSV exports already use,
  not a `fetch`-based flow.
- **`src/db/__tests__/accounting-tally-export.test.ts`** (new, 6 tests) —
  the sign convention and voucher-type mapping against a real posted
  sales voucher; `expense` → Payment plus date-range filtering; XML
  escaping of special characters in ledger names and narration; branch
  name included in narration only when the export spans more than one
  branch; a raw-inserted unbalanced voucher is skipped and reported, not
  exported; a clean empty envelope for a period with no activity.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` on all four touched files — clean.
- Targeted tests (`accounting-tally-export.test.ts`,
  `accounting-journal-report.test.ts`, `check-constraints.test.ts`) —
  17/17 passing, all 6 new Tally export tests passing on first run.
- Full `npx vitest run` — 1654/1662 passing. The 8 failures are the same
  pre-existing, unrelated baseline seen in every prior slice's report in
  this engagement — none touch this slice's code.
- `npm run build` — succeeds cleanly.
- Dev-server smoke test: unauthenticated `GET` on the new route (both the
  XML response and `?format=json`) → `401` with a clean
  `{"error":"Not authenticated"}` body; an unsupported method (`PUT`) →
  `405`.

**What verification here cannot cover:** none of the above proves a real
Tally import accepts this XML. It proves the output matches Tally's own
documented structure and the specific worked example I checked it
against — that is a meaningfully different, weaker claim than "verified,"
and the UI's caveat says so permanently.

## Deliberately out of scope

- **Direct Tally API/live sync.** Only file-based XML export, per the
  master plan's own phrasing ("Tally-compatible export").
- **Synthesizing per-party Tally ledgers from this app's customer/supplier
  tags.** See "Known limitations" above.
- **A "verified" claim of any kind**, until an actual Tally import has
  been tested against this output — the caveat stays in the UI
  permanently, not as a placeholder.

## What's next

This completes every slice in `ACCOUNTING_PHASE_7_PLAN.md` (7a–7f) — the
last phase named in the accounting module's own master plan. If you get a
chance to test this export against a real Tally company, I'd want to hear
what happened (accepted cleanly, needed ledger names adjusted, rejected
outright) so the caveat and mapping can be corrected against a real
result instead of documentation alone.
