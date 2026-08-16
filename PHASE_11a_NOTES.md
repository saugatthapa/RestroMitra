# Phase 11a — Multi-Branch Support

Phase 10 turned DhankiPOS into an actual SaaS product. Phase 11 is the roadmap's
final phase, bundling four independent sub-areas (offline POS, payment
integrations, multi-branch, AI assistant). Multi-branch was picked to go first —
it's entirely self-contained, needs no external credentials or gateway
integration, and every other sub-area can be built without it. This sub-phase
(11a) extends the existing single-branch data model to real multi-branch
support: branch-scoped staff, tables, orders, attendance, and reservations, a
branch switcher/filter in the dashboard UI, and a plan-tied branch cap.

## Why this matters

A momo shop with a second cart in Dharan, or a cafe chain with locations across
Itahari and Biratnagar, needs staff, tables, and orders to stay scoped to the
right physical location — a manager at the Dharan branch shouldn't see (or
touch) the main branch's tables, and a walk-in order placed at one location
shouldn't show up in the other's till. The `branches` table has existed since
Phase 1 (every restaurant silently got one "Main Branch" at onboarding) but
nothing enforced branch boundaries anywhere — this phase turns that dormant
schema into an actually-enforced feature.

## What's done and verified

- **Schema**: `attendance_records.branch_id` and `reservations.branch_id` added
  (both nullable, FK to `branches` with `onDelete: cascade`, each with its own
  index). `restaurant_tables.branch_id` and `orders.branch_id` were already
  `NOT NULL` from earlier phases; `user_roles.branch_id` was already nullable
  (part of the unique scope index on userId+restaurantId+branchId+role).
  `reservations.branch_id` is deliberately an **explicit** column, not derived
  only via a `tableId` join — `reservations.tableId` is nullable (a phone
  booking taken before the floor plan for the night is finalized), so a
  reservation needs to know its branch independently of whether a table has
  been assigned yet.
- **`requireBranchAccess(userId, restaurantId, branchId)`** (`lib/rbac/guard.ts`)
  — pre-existing but previously dead code, now the enforcement primitive wired
  into every branch-sensitive route. Resolves the caller's `user_roles` grant:
  if the grant's own `branchId` is `null` (unrestricted — owner/manager
  spanning every branch), access is granted to any branch of that restaurant
  without further checks. If the grant is branch-scoped, the requested
  `branchId` must exactly match the grant's branch, or a 403 is thrown.
- **Branch-scoping pattern, applied uniformly** across tables, orders,
  attendance, and reservations: every GET-list route computes
  `effectiveBranchId = grantedBranchId ?? ?branchId= query param`, calls
  `requireBranchAccess` when set, and filters the query; every POST/write route
  resolves the target branch via a consistent three-tier fallback — (1) an
  explicit, ownership-validated `branchId` in the request body always wins; (2)
  absent that, a branch-scoped caller's own granted branch is used; (3) absent
  both, an unrestricted caller falls back to the restaurant's main branch via
  the existing `getMainBranch()` helper (so a restaurant that never touches
  multi-branch features sees zero behavior change) — then unconditionally calls
  `requireBranchAccess` before the write.
- **`POST /api/restaurants/[slug]/branches`** and
  **`PATCH .../branches/[branchId]`** (new) — creating a branch is gated by the
  `MANAGE_BRANCHES` permission (owner-only) and enforces a plan-tied branch cap
  (`maxBranchesForRestaurant` in `plans.ts`, mirroring the Phase 10 staff-seat
  cap pattern exactly — Starter: 1, Growth: 3, Pro: unlimited, no-plan trial
  default: 2). The PATCH route encodes two invariants directly: the main branch
  can never be deactivated, and a non-main branch can only be deactivated if at
  least one other active branch would remain — every branch-scoped row
  (`user_roles`, `restaurant_tables`, `orders`) assumes a working home branch
  always exists.
- **Staff branch assignment**: inviting staff (`POST .../staff`) accepts an
  optional `branchId` (validated against the restaurant's own branches),
  stored on the `user_roles` grant; reassigning a staff member's branch is a
  `PATCH .../staff/[userRoleId]` with `branchId: string | null` (`null`
  explicitly clears the scope back to unrestricted). The roster GET returns
  each staff member's `branchName` via a join.
- **Dashboard UI**: a new `/dashboard/branches` page (gated by
  `MANAGE_BRANCHES`) listing active/deactivated branches with rename and
  activate/deactivate controls and an add-branch form; `TablesManager` gained a
  branch filter `<select>` (shown only when the restaurant has more than one
  branch) that passes `?branchId=` to the tables GET and tags the "+ Table"
  button's create call with the currently-filtered branch; `StaffBoard`'s
  roster gained a branch column and an inline branch-reassignment `<select>`
  per staff row, and the invite form gained a branch picker.
- **Deliberate design decision: no server-side "active branch" session
  field.** The app has no existing concept of switching between restaurants
  mid-session either (`setActiveRestaurant` is only ever called once, at
  onboarding, with no route to change it afterward) — adding a persisted
  `sessions.activeBranchId` would have been scope creep inconsistent with that
  existing boundary. Branch filtering in the dashboard is ephemeral,
  client-side `<select>` state passed as a `?branchId=` query parameter,
  defaulting to "all branches." This is purely a UI convenience — a
  branch-scoped staff member is unconditionally restricted server-side by
  `requireBranchAccess` regardless of any client-side filter state, so security
  never depends on the UI getting this right.
- **Tests**: `src/db/__tests__/branch-permissions.test.ts` (8 DB-backed
  integration cases — an unrestricted grant reaching every branch, a
  branch-scoped grant confined to its own branch and rejected for both a
  sibling branch and a different restaurant entirely, `requireRestaurantAccess`
  correctly reporting `branchId` for both grant types, and
  `attendance_records`/`reservations` branch columns round-tripping correctly,
  including a `tableId: null` reservation with an explicit `branchId`). Plus a
  new `describe("maxBranchesForRestaurant", ...)` block in `plans.test.ts`
  mirroring the staff-seat cap tests. 304 tests total after this phase (up from
  291), all passing.
- **Live smoke test** (`scripts/smoke-test-phase11a.sh`, 25 assertions, all
  passing) — the full lifecycle over real HTTP against the real dev server:
  every restaurant starting with exactly one Main branch, creating a second
  branch, the trial's 2-branch cap correctly rejecting a 3rd with a 403 and an
  "upgrade your plan" message, a manager invited with an explicit branch
  correctly receiving it, a scoped manager's table/attendance/reservation
  actions landing in (and being confined to) their own branch, an unrestricted
  owner acting across every branch including creating directly in the main
  branch, the `?branchId=` filter correctly including/excluding the right
  tables, the main-branch and last-active-branch deactivation guardrails, and
  cross-tenant isolation on the branches endpoints themselves.
- **Playwright screenshots** (`scripts/screenshot-phase11a.mjs`, all entity
  names prefixed `Phase11aTour`) — `/dashboard/branches` with the Main +
  second branch cards, the add-branch form open, `/dashboard/tables` unfiltered
  vs. filtered to the second branch, and the staff roster showing a
  branch-scoped manager with the invite form's branch picker open — all
  visually verified.

## A bug caught and fixed while running the smoke test

The first version of `scripts/smoke-test-phase11a.sh` built its curl headers
via a plain function (`hdr() { echo "-H" "..." "-H" "x-forwarded-for: $ip"; }`)
captured through an **unquoted** `$(hdr)` at each call site. Since a couple of
those header values contain spaces (`"Content-Type: application/json"`, the
`x-forwarded-for` value), unquoted command substitution word-split them apart —
curl then received stray bare tokens like `application/json` and the fake IP
itself as **extra positional URL arguments**, not header content, and
proceeded to fire off bogus extra requests to hosts like `203.0.113.x`, which
this sandbox's network egress allowlist correctly rejected. Fixed by making
`hdr()` populate a bash array (`H=(...)`) and expanding it quoted everywhere
(`"${H[@]}"`) — arrays preserve each element's boundaries regardless of
embedded whitespace, so a header's value can never leak into a separate
argument. All 25 assertions pass with the fix.

## Known gaps / deliberately deferred

- **Reservation edits don't recompute `branchId`.** `PATCH
  .../reservations/[id]` doesn't re-derive the branch if `tableId` is changed
  during an edit — the branch is only ever set correctly at creation time.
- **The tables QR-code GET route (`.../tables/[tableId]/qr`) was deliberately
  left branch-unscoped**, consistent with its existing "any staff member with
  restaurant access can fetch it" design — adding branch enforcement there
  would have been an inconsistent, unrequested tightening of an already-settled
  low-sensitivity read.
- **No per-branch menu overrides.** Every branch of a restaurant shares the
  same menu, pricing, and inventory — a branch-specific menu or price list is
  out of scope, unchanged since Phase 2.
- **No branch-level report breakdown.** Reports (Phase 9) remain
  restaurant-wide; slicing sales/inventory/attendance reports by branch is a
  natural but unbuilt extension.
- **No UI for reassigning which branch is "main," and no way to delete (vs.
  deactivate) a branch.** Both would need extra care around what happens to
  rows still pointing at a branch being removed — soft-delete via `isActive`
  was judged sufficient for this sub-phase.
- **Attendance and Reservations dashboard boards have no branch filter UI
  yet**, even though both backend routes already support `?branchId=`
  filtering — only `TablesManager` got the filter dropdown this sub-phase;
  Staff got a branch **assignment** picker, which is a different control (who
  belongs to which branch, not "which branch am I viewing").
- **No persisted "active branch" session state** — see the design decision
  above. A future sub-phase could add this once the app gains a genuine
  multi-restaurant/multi-branch switching UX worth persisting.

## Next steps

1. Ask which of the three remaining Phase 11 sub-areas to build next — offline
   POS, payment integrations, or the AI assistant. Payment integrations need
   real gateway credentials only the user can supply; the AI assistant needs an
   LLM API/budget decision only the user can make — both are blocked on user
   input, unlike multi-branch, which was buildable end-to-end without any
   external dependency.
2. Consider a branch-level report breakdown as a natural follow-up once
   another sub-phase's UI work is already touching the reports pages.
3. Same standing item as every phase: run this against a real Supabase project
   once live credentials are available.
4. Push to GitHub from your machine.
