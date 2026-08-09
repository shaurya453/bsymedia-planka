#!/usr/bin/env bash
set -euo pipefail

# Local backups of the two live volumes: the Postgres data (both databases -
# planka itself, plus planka_ops which holds invite-service state) and the
# `data` volume (PLANKA's uploaded attachments/avatars). Kept outside the git
# repo entirely (not just gitignored) so a `git add -A` mistake can never
# stage a dump full of real user data.
#
# Offsite copy added 2026-08-09: after the local dump+prune below succeeds,
# mirrors $BACKUP_ROOT to Mega via rclone through a "crypt" remote (content
# and filenames encrypted client-side before upload - the raw Mega listing
# shows only scrambled names). Uses `sync`, not `copy`, so the existing
# 14-day local prune below also prunes the offsite copy automatically - no
# separate remote retention job to maintain.

COMPOSE_DIR="/home/deploy/planka"
BACKUP_ROOT="/home/deploy/planka-backups"
LOG_FILE="/home/deploy/planka/logs/backup.log"
RETENTION_DAYS=14

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$TIMESTAMP"

log() {
  printf '%s %s\n' "$(date -Is)" "$1" >> "$LOG_FILE"
}

cd "$COMPOSE_DIR"

if ! docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
  log "ABORT: postgres is not healthy, skipping backup"
  exit 1
fi

mkdir -p "$DEST"

if ! docker compose exec -T postgres pg_dump -U postgres -d planka | gzip > "$DEST/planka.sql.gz"; then
  log "FAILED: pg_dump of planka database"
  rm -rf "$DEST"
  exit 1
fi

if ! docker compose exec -T postgres pg_dump -U postgres -d planka_ops | gzip > "$DEST/planka_ops.sql.gz"; then
  log "FAILED: pg_dump of planka_ops database"
  rm -rf "$DEST"
  exit 1
fi

# Tar the `data` volume's contents via a disposable container that mounts it
# read-only - avoids needing volume internals to be reachable from the host
# filesystem directly.
if ! docker run --rm \
  -v planka_data:/source:ro \
  -v "$DEST":/backup \
  alpine:3.22 \
  tar czf /backup/data.tar.gz -C /source .; then
  log "FAILED: tar of planka_data volume"
  rm -rf "$DEST"
  exit 1
fi

BACKUP_SIZE="$(du -sh "$DEST" | cut -f1)"
log "OK: backup completed at $DEST ($BACKUP_SIZE)"

# Retention: prune backup directories older than RETENTION_DAYS.
find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} \; \
  | while read -r pruned; do log "Pruned old backup: $pruned"; done

# Offsite sync (non-fatal): a transient network hiccup here shouldn't fail
# the whole run when the local backup above already succeeded.
if ! rclone sync "$BACKUP_ROOT" cryptremote:planka-backups --log-file="$LOG_FILE" --log-level INFO; then
  log "WARNING: offsite sync to Mega failed (local backup is still intact)"
fi

exit 0
