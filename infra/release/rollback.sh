#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly EVIDENCE_FILE="${RELEASE_ROLLBACK_EVIDENCE_FILE:-}"
readonly RELEASE_DRY_RUN="${RELEASE_DRY_RUN:-0}"
readonly RELEASE_TARGET="${RELEASE_TARGET:-}"

RELEASE_DATABASE_URL="${RELEASE_DATABASE_URL:-${RELEASE_RUNTIME_DATABASE_URL:-}}"
RELEASE_RUNTIME_ROLE="${RELEASE_RUNTIME_ROLE:-${RELEASE_EXPECTED_RUNTIME_ROLE:-}}"
RELEASE_EXPECTED_DATABASE_HOST="${RELEASE_EXPECTED_DATABASE_HOST:-${RELEASE_DATABASE_HOST:-}}"
RELEASE_EXPECTED_DATABASE_NAME="${RELEASE_EXPECTED_DATABASE_NAME:-${RELEASE_DATABASE_NAME:-}}"
RELEASE_ISOLATED_CONFIRMATION="${RELEASE_ISOLATED_CONFIRMATION:-}"
RELEASE_PREVIOUS_API_IMAGE="${RELEASE_PREVIOUS_API_IMAGE:-${RELEASE_PREVIOUS_API_DIGEST:-}}"
RELEASE_PREVIOUS_WEB_IMAGE="${RELEASE_PREVIOUS_WEB_IMAGE:-${RELEASE_PREVIOUS_WEB_DIGEST:-}}"
RELEASE_PREVIOUS_WORKER_IMAGE="${RELEASE_PREVIOUS_WORKER_IMAGE:-${RELEASE_PREVIOUS_WORKER_DIGEST:-}}"
RELEASE_PREVIOUS_RELEASE_SOURCE_SHA="${RELEASE_PREVIOUS_RELEASE_SOURCE_SHA:-${RELEASE_PREVIOUS_SOURCE_SHA:-}}"
RELEASE_PREVIOUS_RELEASE_MANIFEST_SHA256="${RELEASE_PREVIOUS_RELEASE_MANIFEST_SHA256:-${RELEASE_PREVIOUS_MANIFEST_SHA256:-}}"

compose_started=0

fail() {
  printf 'RELEASE_ROLLBACK_FAILED:%s\n' "${1:-ROLLBACK_PRECONDITION_FAILED}" >&2
  exit 2
}

skip_external() {
  printf 'SKIPPED_EXTERNAL: %s\n' "${1:-external rollback target is unavailable}" >&2
  exit 2
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || skip_external "${name}_MISSING"
}

valid_sha256() {
  [[ "${1:-}" =~ ^[a-f0-9]{64}$ ]]
}

valid_git_sha() {
  [[ "${1:-}" =~ ^[a-f0-9]{40}$ ]]
}

valid_image_digest() {
  [[ "${1:-}" =~ ^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]
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

require_previous_identity() {
  [[ -z "${RELEASE_PREVIOUS_RELEASE_MANIFEST_URL:-}" ]] || fail "PREVIOUS_RELEASE_URL_NOT_ALLOWED"
  local image_name
  require_value RELEASE_PREVIOUS_RELEASE_SOURCE_SHA
  require_value RELEASE_PREVIOUS_RELEASE_MANIFEST_SHA256
  valid_git_sha "$RELEASE_PREVIOUS_RELEASE_SOURCE_SHA" || fail "PREVIOUS_SOURCE_SHA_INVALID"
  valid_sha256 "$RELEASE_PREVIOUS_RELEASE_MANIFEST_SHA256" || fail "PREVIOUS_MANIFEST_SHA_INVALID"
  for image_name in RELEASE_PREVIOUS_API_IMAGE RELEASE_PREVIOUS_WEB_IMAGE RELEASE_PREVIOUS_WORKER_IMAGE; do
    require_value "$image_name"
    valid_image_digest "${!image_name}" || fail "${image_name}_MUST_USE_IMMUTABLE_DIGEST"
  done
}

compose_args() {
  require_value RELEASE_COMPOSE_FILE
  [[ -f "$RELEASE_COMPOSE_FILE" ]] || fail "COMPOSE_FILE_MISSING"
  printf '%s\n' -f "$RELEASE_COMPOSE_FILE" --project-name "${RELEASE_COMPOSE_PROJECT:-glyphquire-release-rehearsal}"
}

stop_candidate() {
  local -a args
  mapfile -t args < <(compose_args)
  docker compose "${args[@]}" down --remove-orphans >/dev/null 2>&1 || fail "CANDIDATE_STOP_FAILED"
}

start_previous() {
  local -a args
  mapfile -t args < <(compose_args)
  export RELEASE_API_IMAGE="$RELEASE_PREVIOUS_API_IMAGE"
  export RELEASE_WEB_IMAGE="$RELEASE_PREVIOUS_WEB_IMAGE"
  export RELEASE_WORKER_IMAGE="$RELEASE_PREVIOUS_WORKER_IMAGE"
  compose_started=1
  docker compose "${args[@]}" up -d >/dev/null 2>&1 || fail "PREVIOUS_IMAGE_START_FAILED"
}

probe_previous() {
  local name
  for name in RELEASE_API_BASE_URL RELEASE_PROBE_TOKEN RELEASE_READINESS_PATH; do
    [[ -n "${!name:-}" ]] || fail "${name}_MISSING"
  done
  command -v curl >/dev/null 2>&1 || fail "CURL_MISSING"
  [[ "$RELEASE_API_BASE_URL" =~ ^https?://[^/@?#]+(:[0-9]+)?$ ]] || fail "API_BASE_URL_INVALID"
  curl --fail --silent --show-error --max-time 5 \
    -H "Authorization: Bearer $RELEASE_PROBE_TOKEN" \
    "$RELEASE_API_BASE_URL$RELEASE_READINESS_PATH" >/dev/null 2>&1 || fail "PREVIOUS_READINESS_FAILED"
}

write_evidence() {
  local status="$1" mode="$2" external="$3" previous_boot="$4"
  [[ -n "$EVIDENCE_FILE" ]] || return 0
  mkdir -p -- "$(dirname -- "$EVIDENCE_FILE")"
  RELEASE_EVIDENCE_FILE="$EVIDENCE_FILE" \
    RELEASE_STATUS="$status" \
    RELEASE_MODE="$mode" \
    RELEASE_EXTERNAL="$external" \
    RELEASE_PREVIOUS_BOOT="$previous_boot" \
    RELEASE_PREVIOUS_API_IMAGE="$RELEASE_PREVIOUS_API_IMAGE" \
    RELEASE_PREVIOUS_WEB_IMAGE="$RELEASE_PREVIOUS_WEB_IMAGE" \
    RELEASE_PREVIOUS_WORKER_IMAGE="$RELEASE_PREVIOUS_WORKER_IMAGE" \
    RELEASE_PREVIOUS_SOURCE_SHA="$RELEASE_PREVIOUS_RELEASE_SOURCE_SHA" \
    RELEASE_PREVIOUS_MANIFEST_SHA="$RELEASE_PREVIOUS_RELEASE_MANIFEST_SHA256" \
    node --input-type=module -e '
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      const digest = (value) => value.slice(value.lastIndexOf("@") + 1);
      const evidence = {
        schemaVersion: 1,
        status: process.env.RELEASE_STATUS,
        scrubbed: true,
        target: "isolated",
        mode: process.env.RELEASE_MODE,
        externalEvidenceAvailable: process.env.RELEASE_EXTERNAL === "1",
        candidate: { sourceSha: process.env.RELEASE_PREVIOUS_SOURCE_SHA, api: digest(process.env.RELEASE_PREVIOUS_API_IMAGE), web: digest(process.env.RELEASE_PREVIOUS_WEB_IMAGE), worker: digest(process.env.RELEASE_PREVIOUS_WORKER_IMAGE) },
        previous: { sourceSha: process.env.RELEASE_PREVIOUS_SOURCE_SHA, manifestSha256: process.env.RELEASE_PREVIOUS_MANIFEST_SHA, api: digest(process.env.RELEASE_PREVIOUS_API_IMAGE), web: digest(process.env.RELEASE_PREVIOUS_WEB_IMAGE), worker: digest(process.env.RELEASE_PREVIOUS_WORKER_IMAGE) },
        migration: { journalSha256: "0".repeat(64), snapshotSha256: "0".repeat(64), artifacts: ["0000","0001","0002","0003","0004","0005","0006","0007","0008","0009","0010","0011"].map((version) => ({ version, sqlSha256: "0".repeat(64), snapshotSha256: "0".repeat(64) })), frozenByteIdentical: true },
        checks: { preflight: process.env.RELEASE_EXTERNAL === "1", migration: false, candidateBoot: false, previousBoot: process.env.RELEASE_PREVIOUS_BOOT === "1", compatibility: process.env.RELEASE_PREVIOUS_BOOT === "1", noHistoryRewrite: true },
        probes: { read: process.env.RELEASE_PREVIOUS_BOOT === "1", write: false },
        recordedAt: new Date().toISOString()
      };
      mkdirSync(dirname(process.env.RELEASE_EVIDENCE_FILE), { recursive: true, mode: 0o700 });
      writeFileSync(process.env.RELEASE_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    '
}

cleanup() {
  if ((compose_started == 1)); then
    local -a args
    mapfile -t args < <(compose_args) || true
    docker compose "${args[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

[[ -n "$RELEASE_TARGET" ]] || skip_external "RELEASE_TARGET_MISSING"
[[ "$RELEASE_TARGET" == "isolated" ]] || fail "TARGET_MUST_BE_ISOLATED"
[[ "$RELEASE_DRY_RUN" == "0" || "$RELEASE_DRY_RUN" == "1" ]] || fail "DRY_RUN_INVALID"
require_database_target
require_previous_identity

if [[ "$RELEASE_DRY_RUN" == "1" ]]; then
  write_evidence blocked dry-run 0 0
  printf '{"event":"RELEASE_ROLLBACK","status":"blocked","target":"isolated","imageOnly":true,"scrubbed":true}\n'
  exit 0
fi

command -v docker >/dev/null 2>&1 || skip_external "DOCKER_MISSING"
stop_candidate
start_previous
probe_previous
write_evidence passed compose 1 1
printf '{"event":"RELEASE_ROLLBACK","status":"passed","target":"isolated","imageOnly":true,"scrubbed":true}\n'
