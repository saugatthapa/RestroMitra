# Phase 8 (part 3) — Expenses: status notes

Continuing the Phase 8 roadmap item ("Staff, attendance, expenses, customers,
reservations, loyalty") — [part 1](./PHASE_8_NOTES.md) covered staff + attendance,
[part 2](./PHASE_8b_NOTES.md) covered customers + loyalty; this slice covers
**expense tracking**, end to end (schema, API, UI, tests, live smoke test,
screenshots). **Reservations** is the last remaining Phase 8 piece; see "Next steps."

## What's done and verified

- **Schema** (`src/db/schema.ts`, migration `0008_stormy_robin_chapel.sql`): one new
  table, `expenses` (`restaurantId`, `category`, `amountInPaisa`, `description`,
  `expenseDate`, `note`, `isVoided`, `recordedByUserId`). Deliberately the simplest
  ledger pattern in this codebase — unlike `payments`/`stock_movements`/
  `loyalty_transactions`, an expense has no downstream cached balance that must stay
  in sync via atomic increments, so it's just a directly-editable row: `PATCH` corrects
  fields in place, and `isVoided` is the soft-delete flag (same idea as `isActive`
  elsewhere, named for this domain — you "void" an expense entry, you don't
  "deactivate" one). `expenseDate` is a `date` column, deliberately separate from
  `createdAt` — an expense is often logged after the fact (e.g. entering yesterday's
  electricity bill today), so "when did this spending happen" and "when was it typed
  in" are different questions.
- **`src/lib/expense-categories.ts`** — a fixed, platform-wide category enum (rent,
  utilities, salaries, supplies, maintenance, marketing, transport, other), pure and
  dependency-free, same pattern as `staff-roles.ts`/`order-status.ts`/
  `loyalty-tiers.ts`. A fixed enum rather than a per-restaurant custom-category table
  (like `suppliers`) is a deliberate MVP simplification — see "Known gaps."
- **A new `MANAGE_EXPENSES` permission**, added to the RBAC catalog
  (`src/lib/rbac/permissions.ts`) and granted to **manager + owner only** by default
  — narrower than `MANAGE_CUSTOMERS` (manager+cashier). Expenses are treated as
  profit-adjacent data, the same trust level as `MANAGE_STAFF`/`MANAGE_INVENTORY`,
  not something handed to every front-of-house role. Adding a new permission
  required re-running `npm run db:seed` against the local DB so the new permission
  and its role_permissions rows actually exist — permission checks query the seeded
  `role_permissions` table, not just the in-code matrix, so this step isn't optional
  after a catalog change.
- **Expenses API** (`.../expenses/`, `.../expenses/[expenseId]/`), gated behind
  `MANAGE_EXPENSES` for both reads and writes:
  - `GET /expenses` — list, filterable by `?category=`, `?from=`/`?to=`
    (YYYY-MM-DD, inclusive), excludes voided entries by default, `?includeVoided=true`
    to see them too.
  - `POST /expenses` — creates an entry; `expenseDate` defaults to today (server-side)
    when omitted.
  - `PATCH /expenses/[id]` — corrects any field, or voids/un-voids via `isVoided`. No
    `DELETE` endpoint, same reasoning as suppliers/menu items: a wrong expense is
    still an audit trail of what was entered and when, so it's voided, not erased.
- **Expenses dashboard UI** (`/dashboard/expenses`, `ExpensesBoard.tsx`) — a
  category/date-range filter bar, a running total for the filtered set broken down
  per category, an add-expense form, and a list with inline correction (click Edit to
  expand a row into an editable form with Save/Cancel/Void). "Expenses" enabled in
  the dashboard nav.
- **Tests**: `src/lib/expense-categories.test.ts`, `src/lib/validation/expenses.test.ts`
  (schema edge cases, including the rupees→paisa conversion and the YYYY-MM-DD date
  format check), `src/db/__tests__/expenses-permissions.test.ts` — proves the
  `MANAGE_EXPENSES` permission split (manager/owner yes, cashier/inventory_manager
  no), tenant isolation, and a real DB round trip including the void flag. 214 tests
  total after this phase (up from 200).
- **Live smoke test** (`scripts/smoke-test-phase8c.sh`, 21 assertions, all passing):
  the `MANAGE_EXPENSES` split over real HTTP (cashier 403 on both list and create,
  manager/owner 200), three expenses created across categories/dates with correct
  rupee→paisa conversion, category filtering, date-range filtering, a PATCH
  correction (amount + note), a cashier correctly refused from correcting too, voiding
  an entry and confirming it drops out of the default list but reappears with
  `?includeVoided=true`, a 404 on a nonexistent expense id, and cross-tenant
  isolation.
- **Playwright screenshots** (`scripts/screenshot-phase8c.mjs`) — seeded four
  expenses across categories and dates (all entity names prefixed `Phase8cTour`),
  captured and visually verified: the expenses list with per-category totals, the
  add-expense form, and the category filter narrowing the list to a single entry.

## Known gaps / deliberately deferred

- **Fixed, platform-wide expense categories**, not a per-restaurant custom-category
  table like `suppliers`. A momo shop and a full-service restaurant likely have
  somewhat different natural categories; the eight chosen here (rent, utilities,
  salaries, supplies, maintenance, marketing, transport, other) cover the common
  cases with "other" as a catch-all. Deferred rather than half-building a settings UI
  for it — `expense-categories.ts` is written so the category list is the only thing
  that would need to become restaurant-scoped data later.
- **No receipt/photo attachment.** An expense has a free-text `note` field but no
  way to attach a scanned receipt or photo — same reason as attendance's deferred
  selfie check-in (Phase 8 part 1): no object storage/file upload infrastructure
  exists yet in this codebase. A natural pairing once that infrastructure exists for
  either feature.
- **No recurring-expense templates.** Rent and salaries are typically the same
  amount every month; today each month's rent has to be entered by hand. A
  "duplicate last month's rent entry" or a scheduled recurring-expense feature would
  save real staff time — flagged as a concrete, well-scoped follow-up rather than
  built speculatively here.
- **No approval workflow.** Any `MANAGE_EXPENSES` holder (manager or owner) can
  both create and immediately have their own entry stand — there's no "manager
  submits, owner approves" flow. Reasonable for the target market (small,
  owner-operated restaurants where the owner and the person recording expenses are
  often the same few people) but would matter more for a multi-location chain with
  delegated managers and less owner oversight per location.
- **No cashier-level "petty cash" recording.** Everyday small cash expenses (e.g. a
  quick supply run paid from the till) might reasonably be logged by a cashier
  rather than requiring a manager, even though the broader expense ledger stays
  manager/owner-gated. A narrower permission or a capped "petty cash" sub-flow is a
  plausible future addition if this turns out to be a common real-world friction
  point.
- **Not yet wired into any profit/reporting view.** Expenses exist as their own
  ledger but aren't netted against revenue anywhere yet — that's squarely Phase 9
  (Analytics & reports) territory, once that phase exists to pull from both this
  ledger and the orders/payments data.

## Next steps

1. Continue Phase 8: **reservations** — the last remaining piece of the Phase 8
   roadmap item.
2. Once Phase 9 (Analytics & reports) exists, wire expenses into a profit/loss view
   alongside order revenue.
3. Consider recurring-expense templates and a lightweight cashier "petty cash" path
   as concrete, well-scoped follow-ups once there's real usage data on which
   friction points actually matter.
4. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
5. Push to GitHub from your machine.
