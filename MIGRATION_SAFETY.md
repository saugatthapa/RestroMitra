# Migration Safety — Verified Procedure

Phase 2 (P1) deliverable. This documents what was actually tested, not a
theoretical procedure — every claim below was verified by running the
actual commands, not inferred.

## What was tested this pass

**Fresh, empty database.** Created a genuinely empty Postgres database
(`restromitra_ci_sim`), ran `npm run db:migrate` against it, and confirmed
all 29 migrations (`0001` through `0029`) applied cleanly with zero
errors — including the two new partial unique indexes from the P0
hardening pass (`service_calls_one_active_per_table_unique`,
`attendance_records_one_open_shift_per_user_unique`), both confirmed
present via `\d service_calls` / `\d attendance_records`.

**A real finding from this test:** a migrated-but-unfreshly-seeded
database has no usable permission system. `role_permissions` (which role
gets which permission — MANAGE_STAFF, MANAGE_INVENTORY, etc.) is
deliberately fixed, non-tenant reference data seeded via `npm run
db:seed` (`src/db/seed.ts`), not baked into the schema migrations
themselves. Running the full test suite against the freshly-migrated
database failed 13 tests — every one a permission check — until `npm run
db:seed` was run. **A fresh database needs `db:migrate` THEN `db:seed`,
never just `db:migrate` alone** — this is now enforced in
`.github/workflows/ci.yml` and should be part of any real disaster-
recovery/new-environment runbook.

After seeding, the full verification suite passed against this fresh
database: `tsc --noEmit` clean, `npm run lint` clean, 628/628 tests
passing, `npm run build` succeeding — proving the whole app (not just the
schema) is usable from a cold start.

**Existing database with real data.** Every migration added during the
P0 hardening pass (`0028_misty_morlocks.sql`,
`0029_busy_white_tiger.sql`) was applied directly against this project's
actual populated development database — the one carrying real
restaurants/orders/staff/reservations data accumulated across this
project's entire history — and both applied without error. Postgres's
own `CREATE UNIQUE INDEX ... WHERE ...` (a partial index) fails outright
at creation time if any existing rows already violate the constraint
being added; a clean apply against real data is itself a positive proof
no existing rows already had two simultaneous active service calls per
table or two simultaneous open shifts per user.

## The safe production migration procedure

For a schema change that only **adds** something (a new index, a new
column, a new table) — the shape of every migration produced so far in
this project:

1. **Take a backup first.** See `BACKUP_RESTORE.md` — a fresh backup
   immediately before any migration, not "there's a nightly one from
   yesterday."
2. **Run `npm run db:migrate` against production directly.** Drizzle's
   migration runner tracks applied migrations in its own
   `__drizzle_migrations` table, so this is idempotent — re-running it
   after a partial failure only applies what's left, never re-applies
   what already succeeded.
3. **A `CREATE UNIQUE INDEX` (or any constraint addition) that fails is
   informative, not just an error** — it means real data already
   violates the invariant the constraint is meant to enforce. Do not
   retry with `DROP ... IF EXISTS` or a weakened constraint to force it
   through. Stop, query the violating rows directly, and decide a real
   fix for that data before re-attempting the migration. (This project's
   own P0-9 follow-up — composite foreign keys across 8 tables for
   tenant/branch integrity, deferred and documented in
   `P0_PHASE_REPORT.md` — is exactly this category: a broad constraint
   addition that needs a pre-migration data audit before it's safe to
   run against production, not before it's safe to write.)
4. **Never write a migration that drops a column or table containing
   real data** without a separate, explicit, human-reviewed data-
   preservation step first (export, archive, or a verified-empty check)
   — this project has not needed one yet; every migration so far has
   been additive.

For a genuinely destructive or ambiguous-risk schema change: stop and
write out the specific risk and a proposed safe path before running
anything against production, the same discipline already applied to the
P0-9 composite-FK follow-up.

## What this doesn't cover yet

This pass verified migration mechanics (empty DB, populated DB, the
seed-step dependency). It did not test migrations against a
**production-scale** dataset (this dev database, while real, is small)
— a `CREATE UNIQUE INDEX` on a multi-million-row table can take
meaningfully longer and hold different locks than on a small one; if
this project's data volume grows substantially, that's worth a dedicated
check before running a future migration against production during
business hours.
