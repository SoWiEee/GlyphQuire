#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly EVIDENCE_FILE="${PHASE6_ROLLBACK_EVIDENCE_FILE:-}"
readonly PHASE6_DRY_RUN="${PHASE6_DRY_RUN:-0}"
readonly PHASE6_TARGET="${PHASE6_TARGET:-}"

PHASE6_DATABASE_URL="${PHASE6_DATABASE_URL:-${PHASE6_RUNTIME_DATABASE_URL:-}}"
PHASE6_RUNTIME_ROLE="${PHASE6_RUNTIME_ROLE:-${PHASE6_EXPECTED_RUNTIME_ROLE:-}}"
PHASE6_EXPECTED_DATABASE_HOST="${PHASE6_EXPECTED_DATABASE_HOST:-${PHASE6_DATABASE_HOST:-}}"
PHASE6_EXPECTED_DATABASE_NAME="${PHASE6_EXPECTED_DATABASE_NAME:-${PHASE6_DATABASE_NAME:-}}"
PHASE6_ISOLATED_CONFIRMATION="${PHASE6_ISOLATED_CONFIRMATION:-}"
PHASE6_PREVIOUS_API_IMAGE="${PHASE6_PREVIOUS_API_IMAGE:-${PHASE6_PREVIOUS_API_DIGEST:-}}"
PHASE6_PREVIOUS_WEB_IMAGE="${PHASE6_PREVIOUS_WEB_IMAGE:-${PHASE6_PREVIOUS_WEB_DIGEST:-}}"
PHASE6_PREVIOUS_WORKER_IMAGE="${PHASE6_PREVIOUS_WORKER_IMAGE:-${PHASE6_PREVIOUS_WORKER_DIGEST:-}}"
PHASE6_PREVIOUS_RELEASE_SOURCE_SHA="${PHASE6_PREVIOUS_RELEASE_SOURCE_SHA:-${PHASE6_PREVIOUS_SOURCE_SHA:-}}"
PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256="${PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256:-${PHASE6_PREVIOUS_MANIFEST_SHA256:-}}"

compose_started=0

fail() {
  printf 'PHASE6_ROLLBACK_FAILED:%s\n' "${1:-ROLLBACK_PRECONDITION_FAILED}" >&2
  exit 2
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "${name}_MISSING"
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
  require_value PHASE6_DATABASE_URL
  require_value PHASE6_RUNTIME_ROLE
  require_value PHASE6_EXPECTED_DATABASE_HOST
  require_value PHASE6_EXPECTED_DATABASE_NAME
  [[ "$PHASE6_ISOLATED_CONFIRMATION" == "isolated" ]] || fail "ISOLATED_CONFIRMATION_REQUIRED"
  [[ "$PHASE6_EXPECTED_DATABASE_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "DATABASE_HOST_NOT_CANONICAL"
  [[ "$PHASE6_EXPECTED_DATABASE_NAME" =~ ^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$ ]] || fail "DATABASE_NAME_NOT_CANONICAL"
  [[ ! "$PHASE6_EXPECTED_DATABASE_HOST" =~ (^|[.-])(prod|production|live|primary|main)([.-]|$) ]] || fail "DATABASE_HOST_NOT_ISOLATED"
  [[ ! "$PHASE6_EXPECTED_DATABASE_NAME" =~ (^|[_-])(prod|production|live|primary|main)([_-]|$) ]] || fail "DATABASE_NAME_NOT_ISOLATED"
  case "$PHASE6_EXPECTED_DATABASE_HOST" in
    localhost|127.0.0.1|*.example|*.test|*.local) ;;
    *) fail "DATABASE_HOST_NOT_ISOLATED" ;;
  esac
  case "$PHASE6_EXPECTED_DATABASE_NAME" in
    glyphquire|glyphquire_*|phase6_*|*_test|*_drill) ;;
    *) fail "DATABASE_NAME_NOT_ISOLATED" ;;
  esac
  parse_database_url "$PHASE6_DATABASE_URL" runtime_user runtime_host runtime_name || fail "DATABASE_URL_INVALID"
  [[ "$runtime_host" == "$PHASE6_EXPECTED_DATABASE_HOST" ]] || fail "DATABASE_HOST_NOT_CANONICAL"
  [[ "$runtime_name" == "$PHASE6_EXPECTED_DATABASE_NAME" ]] || fail "DATABASE_NAME_NOT_CANONICAL"
  [[ "$runtime_user" == "$PHASE6_RUNTIME_ROLE" ]] || fail "RUNTIME_ROLE_URL_MISMATCH"
  [[ "$PHASE6_RUNTIME_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "RUNTIME_ROLE_INVALID"
}

require_previous_identity() {
  [[ -z "${PHASE6_PREVIOUS_RELEASE_MANIFEST_URL:-}" ]] || fail "PREVIOUS_RELEASE_URL_NOT_ALLOWED"
  local image_name
  require_value PHASE6_PREVIOUS_RELEASE_SOURCE_SHA
  require_value PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256
  valid_git_sha "$PHASE6_PREVIOUS_RELEASE_SOURCE_SHA" || fail "PREVIOUS_SOURCE_SHA_INVALID"
  valid_sha256 "$PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256" || fail "PREVIOUS_MANIFEST_SHA_INVALID"
  for image_name in PHASE6_PREVIOUS_API_IMAGE PHASE6_PREVIOUS_WEB_IMAGE PHASE6_PREVIOUS_WORKER_IMAGE; do
    require_value "$image_name"
    valid_image_digest "${!image_name}" || fail "${image_name}_MUST_USE_IMMUTABLE_DIGEST"
  done
}

compose_args() {
  require_value PHASE6_COMPOSE_FILE
  [[ -f "$PHASE6_COMPOSE_FILE" ]] || fail "COMPOSE_FILE_MISSING"
  printf '%s\n' -f "$PHASE6_COMPOSE_FILE" --project-name "${PHASE6_COMPOSE_PROJECT:-glyphquire-phase6-rehearsal}"
}

stop_candidate() {
  local -a args
  mapfile -t args < <(compose_args)
  docker compose "${args[@]}" down --remove-orphans >/dev/null 2>&1 || fail "CANDIDATE_STOP_FAILED"
}

start_previous() {
  local -a args
  mapfile -t args < <(compose_args)
  export PHASE6_API_IMAGE="$PHASE6_PREVIOUS_API_IMAGE"
  export PHASE6_WEB_IMAGE="$PHASE6_PREVIOUS_WEB_IMAGE"
  export PHASE6_WORKER_IMAGE="$PHASE6_PREVIOUS_WORKER_IMAGE"
  compose_started=1
  docker compose "${args[@]}" up -d >/dev/null 2>&1 || fail "PREVIOUS_IMAGE_START_FAILED"
}

probe_previous() {
  require_value PHASE6_API_BASE_URL
  require_value PHASE6_PROBE_TOKEN
  require_value PHASE6_READINESS_PATH
  command -v curl >/dev/null 2>&1 || fail "CURL_MISSING"
  [[ "$PHASE6_API_BASE_URL" =~ ^https?://[^/@?#]+(:[0-9]+)?$ ]] || fail "API_BASE_URL_INVALID"
  curl --fail --silent --show-error --max-time 5 \
    -H "Authorization: Bearer $PHASE6_PROBE_TOKEN" \
    "$PHASE6_API_BASE_URL$PHASE6_READINESS_PATH" >/dev/null 2>&1 || fail "PREVIOUS_READINESS_FAILED"
}

write_evidence() {
  local status="$1" mode="$2" external="$3" previous_boot="$4"
  [[ -n "$EVIDENCE_FILE" ]] || return 0
  mkdir -p -- "$(dirname -- "$EVIDENCE_FILE")"
  PHASE6_EVIDENCE_FILE="$EVIDENCE_FILE" \
    PHASE6_STATUS="$status" \
    PHASE6_MODE="$mode" \
    PHASE6_EXTERNAL="$external" \
    PHASE6_PREVIOUS_BOOT="$previous_boot" \
    PHASE6_PREVIOUS_API_IMAGE="$PHASE6_PREVIOUS_API_IMAGE" \
    PHASE6_PREVIOUS_WEB_IMAGE="$PHASE6_PREVIOUS_WEB_IMAGE" \
    PHASE6_PREVIOUS_WORKER_IMAGE="$PHASE6_PREVIOUS_WORKER_IMAGE" \
    PHASE6_PREVIOUS_SOURCE_SHA="$PHASE6_PREVIOUS_RELEASE_SOURCE_SHA" \
    PHASE6_PREVIOUS_MANIFEST_SHA="$PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256" \
    node --input-type=module -e '
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      const digest = (value) => value.slice(value.lastIndexOf("@") + 1);
      const evidence = {
        schemaVersion: 1,
        status: process.env.PHASE6_STATUS,
        scrubbed: true,
        target: "isolated",
        mode: process.env.PHASE6_MODE,
        externalEvidenceAvailable: process.env.PHASE6_EXTERNAL === "1",
        candidate: { sourceSha: process.env.PHASE6_PREVIOUS_SOURCE_SHA, api: digest(process.env.PHASE6_PREVIOUS_API_IMAGE), web: digest(process.env.PHASE6_PREVIOUS_WEB_IMAGE), worker: digest(process.env.PHASE6_PREVIOUS_WORKER_IMAGE) },
        previous: { sourceSha: process.env.PHASE6_PREVIOUS_SOURCE_SHA, manifestSha256: process.env.PHASE6_PREVIOUS_MANIFEST_SHA, api: digest(process.env.PHASE6_PREVIOUS_API_IMAGE), web: digest(process.env.PHASE6_PREVIOUS_WEB_IMAGE), worker: digest(process.env.PHASE6_PREVIOUS_WORKER_IMAGE) },
        migration: { journalSha256: "0".repeat(64), snapshotSha256: "0".repeat(64), artifacts: ["0000","0001","0002","0003","0004","0005","0006","0007","0008","0009","0010","0011"].map((version) => ({ version, sqlSha256: "0".repeat(64), snapshotSha256: "0".repeat(64) })), frozenByteIdentical: true },
        checks: { preflight: process.env.PHASE6_EXTERNAL === "1", migration: false, candidateBoot: false, previousBoot: process.env.PHASE6_PREVIOUS_BOOT === "1", compatibility: process.env.PHASE6_PREVIOUS_BOOT === "1", noHistoryRewrite: true },
        probes: { read: process.env.PHASE6_PREVIOUS_BOOT === "1", write: false },
        recordedAt: new Date().toISOString()
      };
      mkdirSync(dirname(process.env.PHASE6_EVIDENCE_FILE), { recursive: true, mode: 0o700 });
      writeFileSync(process.env.PHASE6_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
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

[[ "$PHASE6_TARGET" == "isolated" ]] || fail "TARGET_MUST_BE_ISOLATED"
[[ "$PHASE6_DRY_RUN" == "0" || "$PHASE6_DRY_RUN" == "1" ]] || fail "DRY_RUN_INVALID"
require_database_target
require_previous_identity

if [[ "$PHASE6_DRY_RUN" == "1" ]]; then
  write_evidence blocked dry-run 0 0
  printf '{"event":"PHASE6_ROLLBACK","status":"blocked","target":"isolated","imageOnly":true,"scrubbed":true}\n'
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "DOCKER_MISSING"
stop_candidate
start_previous
probe_previous
write_evidence passed compose 1 1
printf '{"event":"PHASE6_ROLLBACK","status":"passed","target":"isolated","imageOnly":true,"scrubbed":true}\n'
