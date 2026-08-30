#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/glyphquire/backups}"
readonly BACKUP_ID="${BACKUP_ID:?BACKUP_ID is required}"
readonly BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
readonly RESTORE_ROOT="${RESTORE_ROOT:-/var/lib/glyphquire/restore-drill}"
readonly EVIDENCE_FILE="${RESTORE_EVIDENCE_FILE:-docs/evidence/phase5/backup-restore-drill.md}"
[[ "$BACKUP_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "invalid BACKUP_ID" >&2; exit 2; }
[[ "$RESTORE_ROOT" != "$BACKUP_ROOT" && "$RESTORE_ROOT" != "$BACKUP_ROOT"/* ]] || { echo "restore target must be isolated" >&2; exit 2; }

db_backup="$BACKUP_ROOT/postgres-${BACKUP_ID}.dump.enc"
object_backup="$BACKUP_ROOT/object-storage-${BACKUP_ID}.tar.enc"
[[ -f "$db_backup" && -f "$object_backup" ]] || { echo "backup artifacts are missing" >&2; exit 1; }
command -v openssl >/dev/null
command -v pg_restore >/dev/null
command -v psql >/dev/null
command -v sha256sum >/dev/null

mkdir -p -- "$RESTORE_ROOT/database" "$RESTORE_ROOT/object-storage" "$(dirname -- "$EVIDENCE_FILE")"
key_file="$RESTORE_ROOT/.key"
printf '%s' "$BACKUP_ENCRYPTION_KEY" >"$key_file"
chmod 600 "$key_file"
openssl enc -d -aes-256-cbc -pbkdf2 -in "$db_backup" -out "$RESTORE_ROOT/database/postgres.dump" -pass "file:$key_file"
pg_restore --clean --if-exists --no-owner --dbname="${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}" "$RESTORE_ROOT/database/postgres.dump"
openssl enc -d -aes-256-cbc -pbkdf2 -in "$object_backup" -out "$RESTORE_ROOT/object-storage/object.tar" -pass "file:$key_file"
tar -C "$RESTORE_ROOT/object-storage" -xf "$RESTORE_ROOT/object-storage/object.tar"

relationship_count="$(psql "$RESTORE_DATABASE_URL" -Atqc 'SELECT count(*) FROM notes n JOIN note_versions v ON v.note_id = n.id JOIN assets a ON a.workspace_id = n.workspace_id;')"
[[ "$relationship_count" =~ ^[0-9]+$ ]] || { echo "relationship verification failed" >&2; exit 1; }
hash_count="$(find "$RESTORE_ROOT/object-storage" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
printf -- '- restore drill `%s`: isolated database/object target verified; note_versions/assets relationships=%s; object hash=%s\n' "$BACKUP_ID" "$relationship_count" "$hash_count" >>"$EVIDENCE_FILE"
rm -f -- "$key_file" "$RESTORE_ROOT/database/postgres.dump" "$RESTORE_ROOT/object-storage/object.tar"
