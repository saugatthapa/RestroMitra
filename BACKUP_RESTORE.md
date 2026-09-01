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

## Automating this — now implemented

This used to be a manual command that only happened when someone remembered
to run it. It's now a scheduled job: `scripts/backup-db.sh` runs the exact
`pg_dump` command above (same flags, same target, same file-naming scheme)
and adds logging + retention on top. It doesn't invent a new backup
mechanism — it automates the one already verified above.

### What it does

- Runs `pg_dump "$DIRECT_URL" -Fc -f <dir>/restromitra-backup-<timestamp>.dump`
  — identical to the manual command above.
- Logs each run's outcome (start, success/failure, file size) with a
  timestamp to `<BACKUP_DIR>/backup.log`, so a failed run is visible without
  having to notice a missing file days later.
- On failure, deletes the partial/corrupt dump file rather than leaving it
  behind looking like a real backup.
- Prunes dump files older than the retention window after a successful run
  (never on a failed one, so a bad backup night doesn't also delete the last
  good backups).

### Where backups are written (the assumption being made)

**Default: `<repo root>/backups/`, a local directory on the same server the
app runs on.** This is documented explicitly because it's a real limitation,
not because it's the ideal answer: this protects against "a bad migration
wiped a table" or "someone deleted data by mistake," but **not** against
"the server itself is lost" (disk failure, account termination, etc.) —
for that, these files need to also land somewhere off that server (object
storage, another host, etc.), which is not implemented here and would need
real credentials for wherever that ends up being. Override the location with
the `BACKUP_DIR` environment variable if a different path is wanted; see
`scripts/backup-db.sh`'s own header comment for every environment variable
it reads.

### Schedule and retention

Default retention is **14 days** (override with `BACKUP_RETENTION_DAYS`),
matching Supabase's own Team-plan retention as a reasonable baseline — see
"Which backup mechanism applies depends on your Supabase plan" above for why
this matters more on Free tier specifically, where this script's daily run
is the *entire* backup story, not a supplement to Supabase's own.

This deployment's model is a single-instance server reached by manual SSH
(see `DEPLOYMENT.md` / README's "Deploying" section) — cron on that same
server, not a separate CI system, is the natural fit, since a GitHub Action
would need its own network path and credentials to reach a database that
otherwise only the server itself talks to.

**Crontab entry** (edit with `crontab -e` on the server, as the same user
that runs the app):

```cron
# RestroMitra: nightly DB backup at 02:15 server time, 14-day retention.
15 2 * * * DIRECT_URL="postgresql://<user>:<pass>@<host>:<port>/<db>" /path/to/RestroMitra/scripts/backup-db.sh >> /path/to/RestroMitra/backups/cron.log 2>&1
```

`DIRECT_URL` is exported directly in the crontab line (cron jobs don't
inherit a login shell's environment, and this script deliberately does not
assume a `.env.local` is present on the server — see the script's own
comment). Use the real production `DIRECT_URL`, not the pooled
`DATABASE_URL` (same reasoning as the manual procedure above).

If this app is hosted on Hostinger (the verified target — see
`DEPLOY_PHASE25.md`), hPanel's own **Advanced → Cron Jobs** screen is an
equally valid way to install this same line, if per-account SSH cron access
is restricted; the command is identical either way.

### Restore verification

`scripts/verify-backup-restore.sh` automates the exact restore-and-check
procedure described above and manually verified this session: it restores a
backup file (the newest one by default, or a specific path) into a
disposable scratch database, checks row-count parity on `restaurants` /
`permissions` / `role_permissions`, confirms both P0-hardening partial
unique indexes survived, and drops the scratch database when done —
success, failure, or interrupted.

```bash
# Verify the most recent backup:
scripts/verify-backup-restore.sh

# Verify a specific one:
scripts/verify-backup-restore.sh backups/restromitra-backup-20260101-021500.dump
```

Run this after setting up the cron schedule above (to confirm the first
scheduled backup actually restores, not just that the file exists), and
periodically afterward — a backup that pg_dump "succeeded" at can still fail
to restore if, e.g., disk filled up mid-write. It exits non-zero on any
mismatch, so it's also safe to wire into a second, less-frequent cron entry
if ongoing automated verification is wanted; that wasn't added by default
here to avoid running an extra `pg_restore` against production every night
without a specific reason to.

### What this still deliberately does NOT do

Same honesty as above, carried forward: this automates the *existence* of
backups. It does not add off-server/off-infrastructure durability (uploading
to S3/R2/Backblaze or similar) — that's still a real next step, and one that
needs actual object-storage credentials for wherever this project's backups
should ultimately live, which isn't something to invent from inside a repo
checkout.
