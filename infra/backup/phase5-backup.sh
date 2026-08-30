#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/glyphquire/backups}"
readonly BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
readonly BACKUP_ID="${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
readonly EVENT_LOG="${BACKUP_EVENT_LOG:-${BACKUP_ROOT}/events.jsonl}"
readonly VERIFY_MARKER="${BACKUP_VERIFY_MARKER:-${BACKUP_ROOT}/backup.verify}"
readonly RETENTION_DAYS=30
readonly WORK_DIR="${BACKUP_ROOT}/.work-${BACKUP_ID}"

failure_reported=0
report_failure() {
  local status=$?
  if (( failure_reported == 0 )); then
    failure_reported=1
    mkdir -p -- "$(dirname -- "$EVENT_LOG")" "$(dirname -- "$VERIFY_MARKER")"
    printf '{"event":"BACKUP_FAILED","type":"backup.verify","status":"failed","backup_id":"scrubbed"}\n' >>"$EVENT_LOG"
    printf '{"type":"backup.verify","status":"failed"}\n' >>"$VERIFY_MARKER"
  fi
  exit "$status"
}
trap report_failure ERR

[[ "$BACKUP_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "invalid BACKUP_ID" >&2; exit 2; }
command -v pg_dump >/dev/null
command -v openssl >/dev/null
command -v tar >/dev/null

mkdir -p -- "$BACKUP_ROOT" "$WORK_DIR"
key_file="$WORK_DIR/key"
printf '%s' "$BACKUP_ENCRYPTION_KEY" >"$key_file"
chmod 600 "$key_file"
db_dump="$WORK_DIR/postgres.dump"
db_backup="$BACKUP_ROOT/postgres-${BACKUP_ID}.dump.enc"
object_stage="$WORK_DIR/object-storage"
object_backup="$BACKUP_ROOT/object-storage-${BACKUP_ID}.tar.enc"

pg_dump_args=(--format=custom --file="$db_dump")
[[ -n "${DATABASE_URL:-}" ]] && pg_dump_args+=("$DATABASE_URL")
pg_dump "${pg_dump_args[@]}"
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$db_dump" -out "$db_backup" -pass "file:$key_file"

mkdir -p -- "$object_stage"
if [[ -n "${OBJECT_STORAGE_SOURCE:-}" ]]; then
  if [[ "$OBJECT_STORAGE_SOURCE" == s3://* ]]; then
    command -v aws >/dev/null
    aws s3 sync --only-show-errors -- "$OBJECT_STORAGE_SOURCE" "$object_stage"
  else
    command -v rsync >/dev/null
    rsync -a -- "$OBJECT_STORAGE_SOURCE"/ "$object_stage"/
  fi
fi
tar -C "$object_stage" -cf - . | openssl enc -aes-256-cbc -pbkdf2 -salt -out "$object_backup" -pass "file:$key_file"

find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name 'postgres-*.dump.enc' -o -name 'object-storage-*.tar.enc' \) -mtime +30 -delete
rm -rf -- "$WORK_DIR"
trap - ERR
exit 0
