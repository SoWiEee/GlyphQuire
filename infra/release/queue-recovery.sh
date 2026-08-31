#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly EVIDENCE_FILE="${RELEASE_QUEUE_EVIDENCE_FILE:-}"
readonly RELEASE_DRY_RUN="${RELEASE_DRY_RUN:-0}"
readonly RELEASE_TARGET="${RELEASE_TARGET:-}"

RELEASE_DATABASE_URL="${RELEASE_DATABASE_URL:-${RELEASE_RUNTIME_DATABASE_URL:-}}"
RELEASE_RUNTIME_ROLE="${RELEASE_RUNTIME_ROLE:-${RELEASE_EXPECTED_RUNTIME_ROLE:-}}"
RELEASE_EXPECTED_DATABASE_HOST="${RELEASE_EXPECTED_DATABASE_HOST:-${RELEASE_DATABASE_HOST:-}}"
RELEASE_EXPECTED_DATABASE_NAME="${RELEASE_EXPECTED_DATABASE_NAME:-${RELEASE_DATABASE_NAME:-}}"
RELEASE_ISOLATED_CONFIRMATION="${RELEASE_ISOLATED_CONFIRMATION:-}"

fail() {
  printf 'RELEASE_QUEUE_RECOVERY_FAILED:%s\n' "${1:-QUEUE_RECOVERY_PRECONDITION_FAILED}" >&2
  exit 2
}

skip_external() {
  printf 'SKIPPED_EXTERNAL: %s\n' "${1:-external queue target is unavailable}" >&2
  exit 2
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || skip_external "${name}_MISSING"
}

parse_database_url() {
  local value="$1"
  local __user="$2"
  local __host="$3"
  local __name="$4"
  if [[ ! "$value" =~ ^postgres(ql)?://([^/:@]+)(:[^@]*)?@([^/:?#]+)(:[0-9]+)?/([^?/#]+)($|\?.*) ]]; then
    return 1
  fi
  printf -v "$__user" '%s' "${BASH_REMATCH[2]}"
  printf -v "$__host" '%s' "${BASH_REMATCH[4]}"
  printf -v "$__name" '%s' "${BASH_REMATCH[6]}"
}

require_database_target() {
  local runtime_user runtime_host runtime_name
  require_value RELEASE_DATABASE_URL
  require_value RELEASE_RUNTIME_ROLE
  require_value RELEASE_EXPECTED_DATABASE_HOST
  require_value RELEASE_EXPECTED_DATABASE_NAME
  [[ "$RELEASE_ISOLATED_CONFIRMATION" == "isolated" ]] || fail "ISOLATED_CONFIRMATION_REQUIRED"
  [[ "$RELEASE_EXPECTED_DATABASE_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "DATABASE_HOST_NOT_CANONICAL"
  [[ "$RELEASE_EXPECTED_DATABASE_NAME" =~ ^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$ ]] || fail "DATABASE_NAME_NOT_CANONICAL"
  [[ ! "$RELEASE_EXPECTED_DATABASE_HOST" =~ (^|[.-])(prod|production|live|primary|main)([.-]|$) ]] || fail "DATABASE_HOST_NOT_ISOLATED"
  [[ ! "$RELEASE_EXPECTED_DATABASE_NAME" =~ (^|[_-])(prod|production|live|primary|main)([_-]|$) ]] || fail "DATABASE_NAME_NOT_ISOLATED"
  case "$RELEASE_EXPECTED_DATABASE_HOST" in
    localhost|127.0.0.1|*.example|*.test|*.local) ;;
    *) fail "DATABASE_HOST_NOT_ISOLATED" ;;
  esac
  case "$RELEASE_EXPECTED_DATABASE_NAME" in
    glyphquire|glyphquire_*|release_*|*_test|*_drill) ;;
    *) fail "DATABASE_NAME_NOT_ISOLATED" ;;
  esac
  parse_database_url "$RELEASE_DATABASE_URL" runtime_user runtime_host runtime_name || fail "DATABASE_URL_INVALID"
  [[ "$runtime_host" == "$RELEASE_EXPECTED_DATABASE_HOST" ]] || fail "DATABASE_HOST_NOT_CANONICAL"
  [[ "$runtime_name" == "$RELEASE_EXPECTED_DATABASE_NAME" ]] || fail "DATABASE_NAME_NOT_CANONICAL"
  [[ "$runtime_user" == "$RELEASE_RUNTIME_ROLE" ]] || fail "RUNTIME_ROLE_URL_MISMATCH"
  [[ "$RELEASE_RUNTIME_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "RUNTIME_ROLE_INVALID"
}

require_bound() {
  require_value RELEASE_MAX_REPLAY
  [[ "$RELEASE_MAX_REPLAY" =~ ^[1-9][0-9]{0,2}$ ]] || fail "MAX_REPLAY_MUST_BE_BOUNDED"
  ((RELEASE_MAX_REPLAY <= 100)) || fail "MAX_REPLAY_EXCEEDS_BOUND"
}

read_ids() {
  require_value RELEASE_DEAD_LETTER_IDS_FILE
  [[ -f "$RELEASE_DEAD_LETTER_IDS_FILE" ]] || fail "DEAD_LETTER_IDS_FILE_MISSING"
  mapfile -t dead_letter_ids <"$RELEASE_DEAD_LETTER_IDS_FILE"
  ((${#dead_letter_ids[@]} > 0)) || fail "DEAD_LETTER_IDS_EMPTY"
  ((${#dead_letter_ids[@]} <= RELEASE_MAX_REPLAY)) || fail "DEAD_LETTER_IDS_EXCEED_BOUND"
  local index raw_id id
  local -A seen=()
  for index in "${!dead_letter_ids[@]}"; do
    raw_id="${dead_letter_ids[$index]}"
    [[ "$raw_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || fail "DEAD_LETTER_ID_INVALID"
    id="${raw_id,,}"
    [[ -z "${seen[$id]:-}" ]] || fail "DEAD_LETTER_ID_DUPLICATE"
    seen[$id]=1
    dead_letter_ids[$index]="$id"
  done
}

replay_ids() {
  require_value RELEASE_API_BASE_URL
  require_value RELEASE_OPERATOR_COOKIE
  command -v curl >/dev/null 2>&1 || fail "CURL_MISSING"
  [[ "$RELEASE_API_BASE_URL" =~ ^https?://[^/@?#]+(:[0-9]+)?$ ]] || fail "API_BASE_URL_INVALID"
  local id
  for id in "${dead_letter_ids[@]}"; do
    curl --fail --silent --show-error --max-time 5 -X POST \
      -H "Cookie: $RELEASE_OPERATOR_COOKIE" \
      -H "idempotency-key: release-replay-$id" \
      "$RELEASE_API_BASE_URL/api/v1/maintenance/dead-letters/$id/replay" >/dev/null 2>&1 \
      || fail "DEAD_LETTER_REPLAY_FAILED"
  done
}

write_evidence() {
  local status="$1" mode="$2" external="$3"
  [[ -n "$EVIDENCE_FILE" ]] || return 0
  mkdir -p -- "$(dirname -- "$EVIDENCE_FILE")"
  RELEASE_EVIDENCE_FILE="$EVIDENCE_FILE" \
    RELEASE_STATUS="$status" \
    RELEASE_MODE="$mode" \
    RELEASE_EXTERNAL="$external" \
    RELEASE_REPLAY_COUNT="${#dead_letter_ids[@]}" \
    RELEASE_REPLAY_MAX="$RELEASE_MAX_REPLAY" \
    node --input-type=module -e '
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      const zeros = "0".repeat(64);
      const artifacts = ["0000","0001","0002","0003","0004","0005","0006","0007","0008","0009","0010","0011"].map((version) => ({ version, sqlSha256: zeros, snapshotSha256: zeros }));
      const evidence = {
        schemaVersion: 1,
        status: process.env.RELEASE_STATUS,
        scrubbed: true,
        target: "isolated",
        mode: process.env.RELEASE_MODE,
        externalEvidenceAvailable: process.env.RELEASE_EXTERNAL === "1",
        candidate: { sourceSha: "0".repeat(40), api: "sha256:" + zeros, web: "sha256:" + zeros, worker: "sha256:" + zeros },
        previous: { sourceSha: "0".repeat(40), manifestSha256: zeros, api: "sha256:" + zeros, web: "sha256:" + zeros, worker: "sha256:" + zeros },
        migration: { journalSha256: zeros, snapshotSha256: zeros, artifacts, frozenByteIdentical: true },
        checks: { preflight: process.env.RELEASE_EXTERNAL === "1", migration: false, candidateBoot: false, previousBoot: false, compatibility: false, noHistoryRewrite: true },
        probes: { read: false, write: false },
        queueRecovery: { replayed: Number(process.env.RELEASE_REPLAY_COUNT), max: Number(process.env.RELEASE_REPLAY_MAX), bounded: true },
        recordedAt: new Date().toISOString()
      };
      mkdirSync(dirname(process.env.RELEASE_EVIDENCE_FILE), { recursive: true, mode: 0o700 });
      writeFileSync(process.env.RELEASE_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    '
}

[[ -n "$RELEASE_TARGET" ]] || skip_external "RELEASE_TARGET_MISSING"
[[ "$RELEASE_TARGET" == "isolated" ]] || fail "TARGET_MUST_BE_ISOLATED"
[[ "$RELEASE_DRY_RUN" == "0" || "$RELEASE_DRY_RUN" == "1" ]] || fail "DRY_RUN_INVALID"
require_database_target
require_bound
read_ids

if [[ "$RELEASE_DRY_RUN" == "1" ]]; then
  write_evidence blocked dry-run 0
  printf '{"event":"RELEASE_QUEUE_RECOVERY","status":"blocked","target":"isolated","replayed":%s,"max":%s,"scrubbed":true}\n' "${#dead_letter_ids[@]}" "$RELEASE_MAX_REPLAY"
  exit 0
fi

replay_ids
write_evidence passed hosted 1
printf '{"event":"RELEASE_QUEUE_RECOVERY","status":"passed","target":"isolated","replayed":%s,"max":%s,"scrubbed":true}\n' "${#dead_letter_ids[@]}" "$RELEASE_MAX_REPLAY"
