# Database Backup & Restore — Verified Procedure

Phase 2 (P1) deliverable. The restore procedure below was actually
executed against a real copy of this project's database this session —
not just described — and it worked. Details at the end.

## Which backup mechanism applies depends on your Supabase plan

This matters and I don't know which plan this project is actually on, so
this is deliberately not a single one-size-fits-all recommendation
(checked against Supabase's current docs, not assumed from training
data):

- **Free tier: no automatic backups exist at all.** Supabase's own docs
  say free-tier projects should "regularly export their data using the
  Supabase CLI `db dump` command" — i.e., the manual procedure below
  isn't a supplement, it's the *only* backup that exists until you
  upgrade.
- **Pro plan: daily backups, 7-day retention**, restorable from the
  Supabase Dashboard's Database → Backups page.
- **Team plan: daily backups, 14-day retention.** Enterprise: 30-day.
- **Point-in-time recovery (PITR)**, granular to the second, is a paid
  add-on on Pro/Team/Enterprise ($100–400/mo depending on retention) —
  not included by default even on a paid plan.

**Action item, not something I can resolve from this sandbox:** confirm
which plan this project's Supabase org is actually on. If it's Free, the
manual procedure below is the entire backup strategy today and should run
on a real schedule (see "Automating this" below), not just exist as a
document.

One Supabase-specific gotcha regardless of plan: **daily/PITR backups do
not store custom role passwords** — a restore from either requires
resetting the app's DB role password afterward. The manual `pg_dump`
procedure below doesn't have this problem (it dumps data, not Postgres
roles).

## The manual procedure (verified this session)

Use `DIRECT_URL`, not `DATABASE_URL`, for both dump and restore. Supabase's
pooled connection (`DATABASE_URL`, pgbouncer transaction mode) is what the
running app uses for short-lived query connections and is not reliable
for a `pg_dump`/`pg_restore` session — `drizzle.config.ts` already makes
this same distinction for migrations, for the same reason.

**Backup:**

```bash
pg_dump "$DIRECT_URL" -Fc -f restromitra-backup-$(date +%Y%m%d-%H%M%S).dump
```

`-Fc` (custom format) is compressed and restorable selectively — don't use
plain-SQL `-Fp` for anything beyond a quick manual read.

**Restore (into a NEW database — never restore directly on top of the live
one without a separate verification step first):**

```bash
createdb -h <host> -U <user> restromitra_restore_check
pg_restore -d "<connection string to restromitra_restore_check>" --no-owner --no-privileges restromitra-backup-<timestamp>.dump
```

Then verify before ever pointing production traffic at a restored
database: row counts on a few key tables, that the two P0-hardening
partial unique indexes exist (`\d service_calls`, `\d attendance_records`
should both show their `_one_active_..._unique` / `_one_open_shift_..._unique`
constraints), and a spot-check of at least one real row.

## What was actually verified this session

Ran this exact procedure against a real snapshot of this project's own
development database (175 restaurants, 28 permissions, 72
role_permissions rows, 40 tables):

1. `pg_dump` the live dev database to a `.dump` file — succeeded, 606KB.
2. Created a genuinely separate scratch database.
3. `pg_restore` the dump into it — succeeded with no errors.
4. Compared: row counts on `restaurants`/`permissions`/`role_permissions`
   matched exactly (175/28/72, identical to the source); all 40 tables
   present; both P0-hardening partial unique indexes
   (`service_calls_one_active_per_table_unique`,
   `attendance_records_one_open_shift_per_user_unique`) survived the
   dump/restore intact; a real restaurant row's `slug`/`name` round-tripped
   correctly.
5. Cleaned up the scratch database.

This proves the MECHANISM works end-to-end — dump format compatibility,
constraint/index preservation, data integrity — against this project's
actual schema. It does not prove anything about Supabase-specific
managed-backup restore UX (the Dashboard-driven Pro/Team restore flow),
since that requires a real paid-tier Supabase project to exercise, which
this sandbox doesn't have access to.

## Automating this

Right now this is a manual command, which means it only happens when
someone remembers to run it — the actual risk on the Free tier especially.
A real next step (not done this pass, flagging honestly rather than
claiming it's handled): a scheduled job (a cron-triggered GitHub Action,
or Hostinger's own scheduled-task feature if it has one) that runs the
`pg_dump` command above against `DIRECT_URL` on a schedule and uploads the
resulting file somewhere durable and OFF the same infrastructure as the
database itself (object storage, not another table in the same Postgres
instance) — so a Supabase-project-level incident doesn't take out the
backups along with the data they're backing up.
