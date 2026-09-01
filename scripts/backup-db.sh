#!/usr/bin/env bash
#
# Automates the manual `pg_dump` procedure documented (and verified) in
# BACKUP_RESTORE.md — it does not invent a new backup mechanism, it just
# runs the existing tested command on a schedule, with logging and
# retention added on top.
#
# Intended to be driven by cron (or Hostinger hPanel's own "Cron Jobs"
# screen, if this app is running there — see DEPLOY_PHASE25.md / README's
# "Deploying" section for that deployment model) on whatever single
# instance is actually running this app. Nothing about this script assumes
# GitHub Actions or any CI system — it's meant to run ON the server, next
# to the app it's backing up, exactly like the manual command it replaces
# was always run from there.
#
# Usage:
#   scripts/backup-db.sh
#
# Required environment:
#   DIRECT_URL   The DIRECT/session Postgres connection string (NOT the
#                pooled DATABASE_URL — see BACKUP_RESTORE.md for why:
#                pg_dump needs a stable session, not a pgbouncer
#                transaction-mode connection). If unset, this script tries
#                to load it from a .env.local file next to the repo root
#                (for local/manual runs); on a real cron entry, export it
#                directly in the crontab line instead (see BACKUP_RESTORE.md's
#                "Automating this" section for the exact crontab example).
#
# Optional environment:
#   BACKUP_DIR             Where dump files are written. Defaults to
#                           <repo root>/backups. Assumption being made here,
#                           documented explicitly rather than left implicit:
#                           this is a LOCAL directory on the same server as
#                           the app and database. That's sufficient to
#                           recover from "someone ran a bad migration" or
#                           "a table got wiped by mistake", but NOT from
#                           "the server itself is gone" — see the note in
#                           BACKUP_RESTORE.md about copying these off-host.
#   BACKUP_RETENTION_DAYS  How many days of backups to keep. Defaults to 14
#                           (matches Supabase's own Team-plan retention, as
#                           a reasonable default — see BACKUP_RESTORE.md for
#                           why this project's actual Supabase plan matters).
#   BACKUP_LOG_FILE        Log file path. Defaults to $BACKUP_DIR/backup.log.
#
# Exit code is 0 only if the dump itself succeeded. Pruning old backups
# happens after a successful dump and never turns a successful backup run
# into a failure (a prune error is logged, not fatal) — but a failed prune
# still doesn't run in this version, see loop below.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# For local/manual runs only — a real crontab entry should export DIRECT_URL
# itself (see BACKUP_RESTORE.md) rather than relying on a checked-out
# .env.local existing on the server.
if [ -z "${DIRECT_URL:-}" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  source "$REPO_ROOT/.env.local"
  set +a
fi

: "${DIRECT_URL:?DIRECT_URL must be set to the DIRECT (non-pooled) Postgres connection string — see BACKUP_RESTORE.md}"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
LOG_FILE="${BACKUP_LOG_FILE:-$BACKUP_DIR/backup.log}"

mkdir -p "$BACKUP_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S%z')] $1" | tee -a "$LOG_FILE"
}

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
FILENAME="restromitra-backup-${TIMESTAMP}.dump"
FILEPATH="$BACKUP_DIR/$FILENAME"

log "Starting backup -> $FILENAME"

if pg_dump "$DIRECT_URL" -Fc -f "$FILEPATH" 2>>"$LOG_FILE"; then
  SIZE="$(du -h "$FILEPATH" | cut -f1)"
  log "Backup succeeded: $FILENAME ($SIZE)"
else
  STATUS=$?
  log "BACKUP FAILED (pg_dump exit $STATUS) for $FILENAME — see log above for pg_dump's own error output"
  rm -f "$FILEPATH"
  exit "$STATUS"
fi

# Retention: delete backups older than RETENTION_DAYS. Only reached after a
# successful dump above, so a prune problem never masks a backup failure.
log "Pruning backups older than ${RETENTION_DAYS} day(s) in $BACKUP_DIR"
DELETED_COUNT=0
while IFS= read -r -d '' old_file; do
  log "Deleting old backup: $(basename "$old_file")"
  rm -f "$old_file"
  DELETED_COUNT=$((DELETED_COUNT + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'restromitra-backup-*.dump' -mtime "+${RETENTION_DAYS}" -print0)
log "Pruned ${DELETED_COUNT} old backup(s)."

log "Backup run complete: $FILENAME"
