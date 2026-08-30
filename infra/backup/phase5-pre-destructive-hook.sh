#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly BACKUP_SCRIPT="${BACKUP_SCRIPT:-$SCRIPT_DIR/phase5-backup.sh}"
[[ -x "$BACKUP_SCRIPT" ]] || { echo "backup script is not executable" >&2; exit 1; }
[[ -n "${BACKUP_ENCRYPTION_KEY:-}" ]] || { echo "BACKUP_ENCRYPTION_KEY is required" >&2; exit 1; }
exec "$BACKUP_SCRIPT"
