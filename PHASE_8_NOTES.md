# Phase 8 (part 1) — Staff management + Attendance: status notes

Phase 8 in the roadmap is a big one: "Staff, attendance, expenses, customers,
reservations, loyalty." Rather than build all six as one untested dump, this slice
covers the first two — **staff management** and **attendance** — end to end (schema,
API, UI, tests, live smoke test, screenshots). Expenses, customers, reservations, and
loyalty are next; see "Next steps."

Staff management was deliberately prioritized first: every phase since Phase 4 has
flagged the same gap in its "Known gaps" section — *"no live HTTP coverage of the
[narrower role] permission split, because there's no staff-invite endpoint yet."* This
phase closes that gap for good. `scripts/smoke-test-phase8.sh` now creates real
manager/waiter/inventory_manager accounts and drives the API as them over actual HTTP,
including a live re-verification of Phase 7's `MANAGE_INVENTORY` split that could
previously only be tested against the DB directly.

## Competitive context

Per the standing instruction to build something better than existing Nepal restaurant-
SaaS competitors (e.g. restrohub.com.np): their staff/attendance offering centers on
PIN-gated POS sessions and selfie-based check-in. This phase matches the core
capability (role-based staff accounts, clock-in/out attendance) with phone+password
auth consistent with the rest of this app, and documents selfie/photo attendance as a
deliberate near-term follow-up (see "Known gaps") rather than silently skipping it.

## What's done and verified

- **Schema** (`src/db/schema.ts`, migration `0006_married_marrow.sql`): one new table,
  `attendance_records` (`restaurantId`, `userId`, `clockInAt`, `clockOutAt` nullable,
  `note`). Staff management itself needed **no new table** — a "staff member" IS a
  `users` row plus a `user_roles` grant, both already in place since Phase 1;
  `userRoles.invitedBy` (unused until now) is finally populated. Attendance is a
  ledger, not a mutable "currently clocked in?" flag — same "ledger over mutable
  single field" reasoning as `payments`/`stock_movements` — with a null `clockOutAt`
  meaning an open shift. "At most one open shift per user per restaurant" is enforced
  at the route/query level, not a DB exclusion constraint (documented as a known gap).
- **`src/lib/attendance.ts`** — pure, dependency-free duration math
  (`isOpenShift`, `computeDurationMinutes`, `formatDuration`, `totalMinutes`), same
  pattern as `order-status.ts`/`payments.ts`/`kds.ts`. **`src/lib/staff-roles.ts`** —
  the assignable-role subset (`manager`/`cashier`/`waiter`/`kitchen_staff`/
  `inventory_manager`), deliberately excluding `owner` (ownership isn't reassigned
  through this flow) and `platform_admin`.
- **Staff API** (`.../staff/`, `.../staff/[userRoleId]/`), gated behind the existing
  `MANAGE_STAFF` permission (already in the catalog since Phase 1, granted to
  owner+manager by default — no new permission needed):
  - `POST` is a find-or-create against the phone number: an existing account (e.g.
    someone who already works at another restaurant — `users.phone` is globally
    unique, one phone is one person account-wide) is just granted a new role at this
    restaurant; a new phone requires `fullName`+`password` and creates a fresh
    account. Refuses a duplicate active grant (409) rather than silently creating a
    second one.
  - `PATCH` changes role and/or active status. Two things it refuses, both fail-closed:
    touching an `owner`/`platform_admin` grant (400 — that's not this flow's job), and
    a caller deactivating their OWN grant (400 — a manager has no structural backstop
    against locking themselves out the way the owner does).
  - `GET` lists everyone with an active role, owner included for roster visibility
    (but not editable).
- **Attendance API** (`.../attendance/clock-in`, `.../attendance/clock-out`,
  `.../attendance`) — no special permission for clock-in/out beyond ordinary
  restaurant membership (it's the caller's own shift); refuses a second clock-in on
  top of an open shift, and a clock-out with no open shift, both with 400. Clock-out
  appends its note to the clock-in note rather than overwriting it. `GET` scope
  differs by permission, not a query param: `MANAGE_STAFF` holders see every staff
  member's records (the roster view a manager needs); everyone else sees only their
  own.
- **Staff dashboard** (`/dashboard/staff`, `StaffBoard.tsx`) — two tabs: Roster (add
  staff, inline role dropdown, deactivate/reactivate, owner shown read-only) and
  Attendance (a self-service clock-in/out card with an optional note, plus a table
  that's self-only or all-staff depending on the caller's `MANAGE_STAFF`).
- **148 → 173 automated tests passing** (+13 pure `attendance.ts`/`staff-roles.ts`
  unit tests, +7 Zod schema tests for `addStaffSchema`/`updateStaffSchema`, +5
  DB-backed integration tests covering the `MANAGE_STAFF` permission split, tenant
  isolation for restaurant access, the "existing active grant" query the staff POST
  route relies on, and a real `attendance_records` round trip). `tsc --noEmit`,
  `eslint`, and `next build` all clean.
- **End-to-end verified over real HTTP** via `scripts/smoke-test-phase8.sh` (24
  assertions, all passing): added a manager, waiter, and inventory_manager as brand-new
  accounts, confirmed a duplicate add is refused (409), confirmed the full roster is
  visible to the owner, **logged in as each new staff account** and drove the API as
  them — waiter gets 403 on the staff roster and on Phase 7's inventory-items route,
  inventory_manager gets 200 on the same inventory route (finally proven over live
  HTTP, not just against the DB), a manager (who also holds `MANAGE_STAFF`) can add
  staff too, escalating a role to `owner` via PATCH is rejected by validation (400), a
  manager can't deactivate their own access (400), clock-in/clock-out round-tripped
  correctly including the double-clock-in/double-clock-out 400s and note-appending,
  attendance visibility split correctly between self-only (waiter) and everyone
  (manager), deactivating the waiter immediately revoked their restaurant access
  (403) even though their session cookie still worked, and cross-tenant isolation
  held for both reading the roster and adding staff. Also walked the Staff dashboard
  visually via Playwright — Roster, Attendance (with one open and one completed
  shift), and the add-staff form — screenshots delivered alongside this write-up.

## Known gaps / deliberately deferred

- **No selfie/photo check-in.** RestroHub's attendance flow includes a selfie capture
  at clock-in as a lightweight fraud check (did the person actually show up, not just
  someone else typing their password). This phase's `attendance_records.note` is a
  natural place to eventually add a `photoUrl` column once object storage is wired up
  (deferred — no file upload infrastructure exists yet in this codebase). Worth
  prioritizing early in a later phase given it's a concrete, well-scoped differentiator
  competitors already ship.
- **No PIN-based quick-switch for shared POS terminals.** Staff log in with
  phone+password like anyone else; a shared till where staff tap a 4-digit PIN to
  identify themselves without a full login is common in restaurant POS (RestroHub does
  this) and would meaningfully speed up shift handoffs on a single POS device. Natural
  fit for the POS (`/dashboard/pos`) UI once there's appetite for it.
- **"At most one open shift" is enforced by a query, not a DB constraint.** A
  Postgres exclusion constraint (or a partial unique index on
  `(user_id, restaurant_id) WHERE clock_out_at IS NULL`) would make this airtight
  against a race between two near-simultaneous clock-in requests; today there's a
  narrow window between the SELECT and the INSERT where two requests could both see
  "no open shift" and both insert one. Low real-world risk (a person can't physically
  submit two clock-ins at once from one device) but worth hardening before this is
  depended on for payroll.
- **No shift editing/correction UI.** If a clock-out is missed or wrong, there's no
  "manager corrects a past record" flow yet — only self-service clock-in/out. A
  natural follow-up once real attendance data is being used for anything
  payroll-adjacent.
- **No email/SMS invite flow.** "Add staff" creates the account directly with a
  password the manager sets and presumably hands to the new hire in person — there's
  no invite-link/OTP flow where the staff member sets their own password. Reasonable
  for a small in-person team (the target market here), less so at any scale; flagged
  for reconsideration if multi-location chains become a bigger part of the target
  audience.
- **Branches aren't wired into staff/attendance yet**, even though `userRoles` and
  `attendance_records` both carry the schema hooks for it (`branchId` on the former,
  deliberately omitted for now on the latter). Single-branch restaurants — the
  large majority of the initial Itahari/Sunsari target market — are unaffected; a
  multi-branch restaurant would currently see one combined roster/attendance view
  across all its branches, not scoped per branch.

## Next steps

1. Continue Phase 8: **customers (CRM) + loyalty program**, then **expenses**, then
   **reservations** — the remaining four pieces of the Phase 8 roadmap item, each to
   get the same schema/lib/API/UI/tests/smoke-test/screenshots treatment as this slice.
2. Consider prioritizing selfie/photo attendance and POS PIN quick-switch soon after,
   given they're concrete features a real competitor (restrohub.com.np) already ships.
3. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
4. Push to GitHub from your machine.
