#!/usr/bin/env bash
#
# Automates the restore-verification procedure documented (and manually
# proven, once) in BACKUP_RESTORE.md's "The manual procedure (verified this
# session)" section: restore a backup file into a disposable scratch
# database, then check that row counts on a few key tables and the two
# P0-hardening partial unique indexes survived the round trip. Never
# touches the live database except to read row counts for comparison, and
# always drops its scratch database afterward, success or failure.
#
# This exists so "does this backup file actually restore?" is a command you
# run, not a claim you trust — matching this project's general "verified,
# not just documented" standard for anything backup/restore related.
#
# Usage:
#   scripts/verify-backup-restore.sh [path/to/backup.dump]
#
# With no argument, verifies the newest file in BACKUP_DIR (default:
# <repo root>/backups) matching restromitra-backup-*.dump — i.e. "did the
# most recent scheduled backup actually restore cleanly?".
#
# Required environment: DIRECT_URL (see backup-db.sh / BACKUP_RESTORE.md).
# Optional environment: BACKUP_DIR (same default/meaning as backup-db.sh).
#
# Exit code 0 = restore succeeded AND every check passed. Non-zero = either
# the restore itself failed, or it "succeeded" but the data doesn't match
# (a corrupt/incomplete backup that pg_restore didn't error on).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${DIRECT_URL:-}" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  source "$REPO_ROOT/.env.local"
  set +a
fi

: "${DIRECT_URL:?DIRECT_URL must be set to the DIRECT (non-pooled) Postgres connection string — see BACKUP_RESTORE.md}"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S%z')] $1"
}

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE="$(ls -t "$BACKUP_DIR"/restromitra-backup-*.dump 2>/dev/null | head -n1 || true)"
fi
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  log "No backup file found (looked in $BACKUP_DIR, or pass a path explicitly). Nothing to verify."
  exit 1
fi

log "Verifying: $BACKUP_FILE"

# Build a scratch-database connection string by swapping the dbname
# component of DIRECT_URL (everything after the last "/" and before any
# "?query" suffix) for a disposable, unpredictable name.
SCRATCH_DB="restromitra_restore_check_$$_$(date +%s)"
SCRATCH_URL="$(printf '%s' "$DIRECT_URL" | sed -E "s#(/)([^/?]+)(\?.*)?\$#\1${SCRATCH_DB}\3#")"

if [ "$SCRATCH_URL" = "$DIRECT_URL" ]; then
  log "Could not derive a scratch database name from DIRECT_URL — refusing to continue (would risk touching the real database)."
  exit 1
fi

cleanup() {
  psql "$DIRECT_URL" -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "Creating scratch database: $SCRATCH_DB"
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SCRATCH_DB\";"

log "Restoring backup into scratch database..."
if ! pg_restore -d "$SCRATCH_URL" --no-owner --no-privileges "$BACKUP_FILE"; then
  log "FAIL: pg_restore reported errors restoring $BACKUP_FILE"
  exit 1
fi
log "Restore completed without error."

FAILED=0

# Row-count parity on a handful of tables that should always be non-trivial
# in a real database — same tables spot-checked manually in BACKUP_RESTORE.md.
for TABLE in restaurants permissions role_permissions; do
  SRC_COUNT="$(psql "$DIRECT_URL" -tAc "select count(*) from \"$TABLE\";" 2>/dev/null || echo "ERROR")"
  DST_COUNT="$(psql "$SCRATCH_URL" -tAc "select count(*) from \"$TABLE\";" 2>/dev/null || echo "ERROR")"
  if [ "$SRC_COUNT" = "ERROR" ] || [ "$DST_COUNT" = "ERROR" ]; then
    log "FAIL: could not read row count for \"$TABLE\" (source=$SRC_COUNT restored=$DST_COUNT)"
    FAILED=1
  elif [ "$SRC_COUNT" != "$DST_COUNT" ]; then
    log "FAIL: row count mismatch on \"$TABLE\" — source=$SRC_COUNT restored=$DST_COUNT"
    FAILED=1
  else
    log "OK: \"$TABLE\" row count matches ($DST_COUNT)"
  fi
done

# The two P0-hardening partial unique indexes BACKUP_RESTORE.md calls out
# by name as proof the dump/restore preserves constraints, not just rows.
EXPECTED_INDEXES=(
  "service_calls_one_active_per_table_unique"
  "attendance_records_one_open_shift_per_user_unique"
)
for IDX in "${EXPECTED_INDEXES[@]}"; do
  FOUND="$(psql "$SCRATCH_URL" -tAc "select 1 from pg_indexes where indexname = '$IDX';" 2>/dev/null | tr -d '[:space:]')"
  if [ "$FOUND" = "1" ]; then
    log "OK: index $IDX present in restored database"
  else
    log "FAIL: index $IDX missing from restored database"
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  log "RESULT: restore verification FAILED for $BACKUP_FILE"
  exit 1
fi

log "RESULT: restore verification PASSED for $BACKUP_FILE"
