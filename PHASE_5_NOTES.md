# Phase 5 — POS, billing, payments, split bills: status notes

Scope per the product spec: give staff a way to create orders themselves (walk-ins,
phone orders, dine-in keyed in at the table) through the same order engine Phase 4
built, and turn a served order into an actual paid bill — including split payments
across multiple methods and refunds.

## What's done and verified

- **Billing schema** (`src/db/schema.ts`, migration `0003_heavy_human_torch.sql`): a
  new `payments` table modeled as a ledger, not a single "amount paid" field on the
  order — `amountInPaisa` is positive for a payment, negative for a refund. An order's
  net paid is the *sum* of its payment rows. This is also how split bills work: two
  customers splitting one order's total each get their own payment row (e.g. Rs 180
  cash + Rs 120 card) — no separate "split" concept needed anywhere else in the schema.
  `orders` gained a `payment_status` column (`unpaid` / `partially_paid` / `paid`),
  cached for cheap list/board reads but always *derived*, never hand-set — see below.
- **`src/lib/payments.ts`** — the single source of truth for billing math, dependency-
  free (no `server-only`, no DB import) exactly like `order-status.ts`, so it's shared
  unmodified between API routes and the dashboard bill view and is trivially unit-
  tested: `computeNetPaid`, `computePaymentStatus`, `computeRemainingDue`, and
  `computeBillingSummary` (bundles all three). There is deliberately no separate
  "refunded" status — a fully refunded order's net paid drops back to zero and it just
  reads `unpaid` again; the refund itself stays visible as its own ledger line for
  anyone who needs to see what actually happened.
- **`POST /api/restaurants/[slug]/orders`** — staff/POS order creation, source=`pos`.
  Reuses `computeOrderPricing()` from Phase 3 unchanged, so a staff-keyed order is
  priced exactly as server-side-safely as a QR order — there is still no price field
  anywhere in the request schema for a client (or a compromised staff terminal) to
  tamper with. Takes an optional `tableId` (verified to belong to the calling
  restaurant, exactly like table creation does) for dine-in, or defaults to the
  restaurant's main branch for takeaway.
- **`GET /api/restaurants/[slug]/orders/[orderId]`** — full order detail: items,
  add-ons, table, and the complete payment ledger, plus a computed `billing` summary
  (via `computeBillingSummary`) so the client never has to re-derive it.
- **`POST /api/restaurants/[slug]/orders/[orderId]/payments`** — records a payment.
  Requires `EDIT_ORDER` (recording what was paid is ordinary order handling, same
  permission level as editing an order's items — not a privileged action). Rejects an
  amount greater than the remaining due, and rejects any payment against a `cancelled`
  order. Recomputes and caches `orders.payment_status` on every call.
- **`POST /api/restaurants/[slug]/orders/[orderId]/refunds`** — records a refund as a
  negative-amount row in the same `payments` ledger. Requires `REFUND_ORDER` — a step
  up from `EDIT_ORDER`, since reversing money already taken needs more trust than
  recording it. Rejects a refund greater than the net amount actually paid so far.
  Deliberately **not** blocked on `status === "cancelled"`: refunding money for an
  order that was cancelled after being paid is exactly the case this needs to handle,
  not reject.
- **Permission matrix widened**: `REFUND_ORDER` moved from owner-only to owner +
  manager in `DEFAULT_ROLE_PERMISSIONS` (`src/lib/rbac/permissions.ts`). Requiring the
  restaurant owner personally for every refund isn't realistic for day-to-day
  operations; cashier/waiter still can't refund — they can record payments (via
  `EDIT_ORDER`) but reversing money needs the manager tier. Re-seeded into
  `role_permissions` via `npm run db:seed` (idempotent).
- **POS dashboard UI** (`/dashboard/pos`, `POSOrderBuilder.tsx`) — category tabs, an
  item grid, and the same variant/add-on customize modal pattern as the public QR
  ordering page (deliberately reused, not reinvented), with a persistent cart panel:
  choose Takeaway or Dine-in (+ table picker), optional customer name/phone/notes,
  live running total, and a "Place order" button that posts to the new staff order
  endpoint and lands on the new order's bill page.
- **Order bill/payment view** (`/dashboard/orders/[orderId]`, `OrderBillView.tsx`) — an
  itemized bill (subtotal/tax/total/paid/remaining due), the order's current status
  with the same advance/cancel actions the Orders board has (so staff don't need to
  bounce between two screens), the full payment history, a "Record a payment" form
  (defaults to the exact remaining due, method picker, optional cash-received field
  that shows change due), and — for managers/owners — an "Issue a refund" form that can
  optionally be tied to a specific prior payment for traceability. Has a "Print bill"
  button and print-friendly styling (`print:hidden` on the nav/action chrome) for a
  physical receipt handoff. The Orders board's order cards now link straight to this
  page.
- **96 automated tests passing** (up from 69 in Phase 4: +21 pure billing-math unit
  tests covering every status transition including full/partial refunds and edge cases
  like a zero-total order, +6 DB-backed tenant-isolation/permission integration tests
  proving the widened `REFUND_ORDER` grant, the still-denied waiter case, and that
  payments never leak across the tenant boundary). `tsc --noEmit`, `eslint`, and
  `next build` all clean.
- **End-to-end verified over real HTTP** via `scripts/smoke-test-phase5.sh` (15
  assertions, all passing): created a real POS order and confirmed its total was
  computed server-side (2 × Rs 150 = Rs 300, not trusted from the client), confirmed a
  table from another restaurant is rejected with 404, confirmed an overpayment is
  rejected, drove a real two-part split payment (cash then card) to `paid`, confirmed a
  further payment on a fully-paid order is rejected, recorded a partial refund and
  confirmed it's stored as a negative amount and drops the order back to
  `partially_paid`, confirmed an over-large refund is rejected, confirmed a payment
  against a cancelled order is rejected, and confirmed a second restaurant owner gets a
  clean 403 on order detail, payments, and refunds alike. Also walked the whole flow
  visually via Playwright — browsing the POS menu, customizing an item, building a
  dine-in cart, placing the order, and watching a partially-paid bill flip to fully
  paid — screenshots delivered alongside this write-up.

## Known gaps / deliberately deferred

- **No item-level bill splitting.** Split bills work by *amount* across multiple
  payment rows (e.g. "Rs 180 cash + Rs 120 card"), not by assigning specific items to
  specific payers ("Rahul had the momo, Priya had the chowmein"). The ledger model
  supports amount-splitting cleanly with no schema changes; item-level splitting would
  need a real UI for dragging/assigning items to sub-bills and was judged not worth the
  complexity for this phase. Revisit if customer demand shows up for it.
- **No live HTTP coverage of the waiter-denied-REFUND_ORDER case.** Same reason as
  Phase 4's cancel-permission gap: there's no staff-invite endpoint yet (Phase 8), so
  the smoke test can only drive the API as the owner. The actual enforcement is proven
  directly against the seeded `role_permissions` data in
  `src/db/__tests__/payments-tenant-permissions.test.ts` instead.
- **No receipt/invoice PDF, no thermal printer integration.** "Print bill" is a
  browser print of the on-screen bill view (works for any regular or receipt-width
  printer via the browser's print dialog), not a generated PDF or ESC/POS thermal
  printer feed. Fine for now; revisit if a restaurant specifically needs 80mm receipt
  hardware output (Phase 11 territory — "payment integrations" — per the original
  roadmap).
- **No online/pay-ahead payment methods** (eSewa, Khalti, cards via a payment gateway)
  — `PAYMENT_METHODS` includes `mobile_wallet` and `card` as *manually recorded*
  methods only (staff types in "customer paid by Khalti, Rs 500" the same way they'd
  record cash). Actual gateway integration is explicitly Phase 11 scope.
- **No discounts/comps/service charge line.** The bill shows subtotal, tax, and total
  exactly as Phase 3's pricing engine computes them — there's no "10% off" or "comp
  this item" action yet. Not part of this phase's scope per the build plan; flagging so
  it isn't mistaken for an oversight.
- **`payment_status` is a cached, derived value**, recomputed on every payment/refund
  write — there's no scheduled reconciliation job that would catch it drifting from the
  ledger if a row were ever edited/deleted directly in the database outside the API.
  Not a concern under normal operation (nothing else writes to `payments`), but worth
  knowing if data is ever hand-edited for a support case.

## Next steps

1. Phase 6 (Kitchen Display System + KOT) is next — turns the "New/Confirmed/
   Preparing/Ready" columns kitchen staff actually care about into their own
   ticket-based view, scoped to `VIEW_KDS`/`UPDATE_KDS_STATUS` rather than the full
   Orders board.
2. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
3. Push to GitHub from your machine.
