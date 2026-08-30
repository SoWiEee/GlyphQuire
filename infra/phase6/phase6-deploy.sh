#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly MIGRATIONS_DIR="${PHASE6_MIGRATIONS_DIR:-$REPOSITORY_ROOT/packages/database/src/migrations}"
readonly EVIDENCE_FILE="${PHASE6_EVIDENCE_FILE:-$REPOSITORY_ROOT/docs/evidence/phase6/deployment-rehearsal.json}"
readonly PHASE6_DRY_RUN="${PHASE6_DRY_RUN:-0}"
readonly PHASE6_TARGET="${PHASE6_TARGET:-}"

PHASE6_DATABASE_URL="${PHASE6_DATABASE_URL:-${PHASE6_RUNTIME_DATABASE_URL:-}}"
PHASE6_MIGRATION_DATABASE_URL="${PHASE6_MIGRATION_DATABASE_URL:-}"
PHASE6_RUNTIME_ROLE="${PHASE6_RUNTIME_ROLE:-${PHASE6_EXPECTED_RUNTIME_ROLE:-}}"
PHASE6_MIGRATION_ROLE="${PHASE6_MIGRATION_ROLE:-${PHASE6_EXPECTED_MIGRATION_ROLE:-}}"
PHASE6_EXPECTED_DATABASE_HOST="${PHASE6_EXPECTED_DATABASE_HOST:-${PHASE6_DATABASE_HOST:-}}"
PHASE6_EXPECTED_DATABASE_NAME="${PHASE6_EXPECTED_DATABASE_NAME:-${PHASE6_DATABASE_NAME:-}}"
PHASE6_S3_ENDPOINT="${PHASE6_S3_ENDPOINT:-${PHASE6_OBJECT_STORAGE_URL:-}}"
PHASE6_EXPECTED_BUCKET="${PHASE6_EXPECTED_BUCKET:-${PHASE6_S3_BUCKET:-}}"
PHASE6_CANDIDATE_API_IMAGE="${PHASE6_CANDIDATE_API_IMAGE:-${PHASE6_CANDIDATE_API_DIGEST:-}}"
PHASE6_CANDIDATE_WEB_IMAGE="${PHASE6_CANDIDATE_WEB_IMAGE:-${PHASE6_CANDIDATE_WEB_DIGEST:-}}"
PHASE6_CANDIDATE_WORKER_IMAGE="${PHASE6_CANDIDATE_WORKER_IMAGE:-${PHASE6_CANDIDATE_WORKER_DIGEST:-}}"
PHASE6_PREVIOUS_API_IMAGE="${PHASE6_PREVIOUS_API_IMAGE:-${PHASE6_PREVIOUS_API_DIGEST:-}}"
PHASE6_PREVIOUS_WEB_IMAGE="${PHASE6_PREVIOUS_WEB_IMAGE:-${PHASE6_PREVIOUS_WEB_DIGEST:-}}"
PHASE6_PREVIOUS_WORKER_IMAGE="${PHASE6_PREVIOUS_WORKER_IMAGE:-${PHASE6_PREVIOUS_WORKER_DIGEST:-}}"
PHASE6_CANDIDATE_SOURCE_SHA="${PHASE6_CANDIDATE_SOURCE_SHA:-${GITHUB_SHA:-}}"
PHASE6_PREVIOUS_RELEASE_SOURCE_SHA="${PHASE6_PREVIOUS_RELEASE_SOURCE_SHA:-${PHASE6_PREVIOUS_SOURCE_SHA:-}}"
PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256="${PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256:-${PHASE6_PREVIOUS_MANIFEST_SHA256:-}}"

failure_code="DEPLOYMENT_PRECONDITION_FAILED"
work_dir=""
compose_started=0

fail() {
  local code="${1:-$failure_code}"
  printf 'PHASE6_DEPLOY_FAILED:%s\n' "$code" >&2
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
  local value="${1:-}"
  [[ "$value" =~ ^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]
}

parse_database_url() {
  local value="$1"
  local __user="$2"
  local __host="$3"
  local __name="$4"
  local user host name
  if [[ ! "$value" =~ ^postgres(ql)?://([^/:@]+)(:[^@]*)?@([^/:?#]+)(:[0-9]+)?/([^?/#]+)($|\?.*) ]]; then
    return 1
  fi
  user="${BASH_REMATCH[2]}"
  host="${BASH_REMATCH[4]}"
  name="${BASH_REMATCH[6]}"
  printf -v "$__user" '%s' "$user"
  printf -v "$__host" '%s' "$host"
  printf -v "$__name" '%s' "$name"
}

require_database_target() {
  local runtime_user runtime_host runtime_name
  local migration_user migration_host migration_name
  require_value PHASE6_DATABASE_URL
  require_value PHASE6_MIGRATION_DATABASE_URL
  require_value PHASE6_RUNTIME_ROLE
  require_value PHASE6_MIGRATION_ROLE
  require_value PHASE6_EXPECTED_DATABASE_HOST
  require_value PHASE6_EXPECTED_DATABASE_NAME
  parse_database_url "$PHASE6_DATABASE_URL" runtime_user runtime_host runtime_name || fail "DATABASE_URL_INVALID"
  parse_database_url "$PHASE6_MIGRATION_DATABASE_URL" migration_user migration_host migration_name || fail "MIGRATION_DATABASE_URL_INVALID"
  [[ "$runtime_host" == "$PHASE6_EXPECTED_DATABASE_HOST" ]] || fail "DATABASE_HOST_NOT_CANONICAL"
  [[ "$migration_host" == "$PHASE6_EXPECTED_DATABASE_HOST" ]] || fail "MIGRATION_HOST_NOT_CANONICAL"
  [[ "$runtime_name" == "$PHASE6_EXPECTED_DATABASE_NAME" ]] || fail "DATABASE_NAME_NOT_CANONICAL"
  [[ "$migration_name" == "$PHASE6_EXPECTED_DATABASE_NAME" ]] || fail "MIGRATION_NAME_NOT_CANONICAL"
  [[ "$runtime_user" == "$PHASE6_RUNTIME_ROLE" ]] || fail "RUNTIME_ROLE_URL_MISMATCH"
  [[ "$migration_user" == "$PHASE6_MIGRATION_ROLE" ]] || fail "MIGRATION_ROLE_URL_MISMATCH"
  [[ "$PHASE6_RUNTIME_ROLE" != "$PHASE6_MIGRATION_ROLE" ]] || fail "MIGRATION_RUNTIME_ROLES_NOT_SEPARATE"
  [[ "$PHASE6_DATABASE_URL" != "$PHASE6_MIGRATION_DATABASE_URL" ]] || fail "MIGRATION_RUNTIME_URLS_NOT_SEPARATE"
  [[ "$PHASE6_RUNTIME_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "RUNTIME_ROLE_INVALID"
  [[ "$PHASE6_MIGRATION_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "MIGRATION_ROLE_INVALID"
}

require_object_target() {
  require_value PHASE6_S3_ENDPOINT
  require_value PHASE6_EXPECTED_BUCKET
  [[ "$PHASE6_S3_ENDPOINT" =~ ^https?://[^/@?#]+(:[0-9]+)?$ ]] || fail "OBJECT_STORAGE_ENDPOINT_INVALID"
  [[ "$PHASE6_EXPECTED_BUCKET" =~ ^[a-z0-9](\.?[a-z0-9-]+)*$ ]] || fail "OBJECT_STORAGE_BUCKET_INVALID"
}

require_release_identity() {
  [[ -z "${PHASE6_PREVIOUS_RELEASE_MANIFEST_URL:-}" ]] || fail "PREVIOUS_RELEASE_URL_NOT_ALLOWED"
  require_value PHASE6_CANDIDATE_SOURCE_SHA
  require_value PHASE6_PREVIOUS_RELEASE_SOURCE_SHA
  require_value PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256
  valid_git_sha "$PHASE6_CANDIDATE_SOURCE_SHA" || fail "CANDIDATE_SOURCE_SHA_INVALID"
  valid_git_sha "$PHASE6_PREVIOUS_RELEASE_SOURCE_SHA" || fail "PREVIOUS_SOURCE_SHA_INVALID"
  valid_sha256 "$PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256" || fail "PREVIOUS_MANIFEST_SHA_INVALID"

  local image_name image_value
  for image_name in \
    PHASE6_CANDIDATE_API_IMAGE PHASE6_CANDIDATE_WEB_IMAGE PHASE6_CANDIDATE_WORKER_IMAGE \
    PHASE6_PREVIOUS_API_IMAGE PHASE6_PREVIOUS_WEB_IMAGE PHASE6_PREVIOUS_WORKER_IMAGE; do
    require_value "$image_name"
    image_value="${!image_name}"
    valid_image_digest "$image_value" || fail "${image_name}_MUST_USE_IMMUTABLE_DIGEST"
  done
  [[ "$PHASE6_CANDIDATE_SOURCE_SHA" != "$PHASE6_PREVIOUS_RELEASE_SOURCE_SHA" ]] || fail "CANDIDATE_AND_PREVIOUS_RELEASE_MATCH"
}

frozen_files=()
frozen_versions=(0000 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011)

find_frozen_files() {
  local version sql_file snapshot_file
  shopt -s nullglob
  [[ -d "$MIGRATIONS_DIR" ]] || fail "MIGRATIONS_DIRECTORY_MISSING"
  [[ -f "$MIGRATIONS_DIR/meta/_journal.json" ]] || fail "MIGRATION_JOURNAL_MISSING"
  frozen_files=("$MIGRATIONS_DIR/meta/_journal.json")
  for version in "${frozen_versions[@]}"; do
    local sql_files=("$MIGRATIONS_DIR/${version}_"*.sql)
    ((${#sql_files[@]} == 1)) || fail "FROZEN_MIGRATION_${version}_INVALID"
    sql_file="${sql_files[0]}"
    snapshot_file="$MIGRATIONS_DIR/meta/${version}_snapshot.json"
    [[ -f "$snapshot_file" ]] || fail "FROZEN_SNAPSHOT_${version}_MISSING"
    frozen_files+=("$sql_file" "$snapshot_file")
  done
}

capture_frozen_hashes() {
  local destination="$1"
  : >"$destination"
  local file
  for file in "${frozen_files[@]}"; do
    sha256sum -- "$file" | awk '{print $1}' >>"$destination"
  done
}

assert_frozen_hashes() {
  local before="$1"
  local after="$2"
  cmp -s "$before" "$after" || fail "FROZEN_MIGRATION_BYTES_CHANGED"
}

quiet() {
  "$@" >/dev/null 2>&1 || fail "EXTERNAL_PREFLIGHT_FAILED"
}

run_database_preflight() {
  command -v psql >/dev/null 2>&1 || fail "PSQL_MISSING"
  quiet psql "$PHASE6_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$REPOSITORY_ROOT/infra/postgres/upgrade/002_role_preflight.sql"
  quiet env MIGRATION_DATABASE_URL="$PHASE6_MIGRATION_DATABASE_URL" pnpm --filter @glyphquire/database migrate
  quiet env MIGRATION_DATABASE_URL="$PHASE6_MIGRATION_DATABASE_URL" pnpm --filter @glyphquire/database db:verify-baseline
}

run_object_preflight() {
  command -v aws >/dev/null 2>&1 || fail "AWS_CLI_MISSING"
  quiet env AWS_ENDPOINT_URL="$PHASE6_S3_ENDPOINT" \
    aws s3api head-bucket --bucket "$PHASE6_EXPECTED_BUCKET"
}

compose_args() {
  require_value PHASE6_COMPOSE_FILE
  [[ -f "$PHASE6_COMPOSE_FILE" ]] || fail "COMPOSE_FILE_MISSING"
  printf '%s\n' -f "$PHASE6_COMPOSE_FILE" --project-name "${PHASE6_COMPOSE_PROJECT:-glyphquire-phase6-rehearsal}"
}

start_services() {
  local api_image="$1" web_image="$2" worker_image="$3"
  local -a args
  mapfile -t args < <(compose_args)
  export PHASE6_API_IMAGE="$api_image"
  export PHASE6_WEB_IMAGE="$web_image"
  export PHASE6_WORKER_IMAGE="$worker_image"
  compose_started=1
  quiet docker compose "${args[@]}" up -d
}

stop_services() {
  if ((compose_started == 1)); then
    local -a args
    mapfile -t args < <(compose_args) || true
    docker compose "${args[@]}" down --remove-orphans >/dev/null 2>&1 || true
    compose_started=0
  fi
}

probe_services() {
  require_value PHASE6_API_BASE_URL
  require_value PHASE6_PROBE_TOKEN
  require_value PHASE6_READ_PROBE_PATH
  require_value PHASE6_WRITE_PROBE_PATH
  command -v curl >/dev/null 2>&1 || fail "CURL_MISSING"
  [[ "$PHASE6_API_BASE_URL" =~ ^https?://[^/@?#]+(:[0-9]+)?$ ]] || fail "API_BASE_URL_INVALID"
  quiet curl --fail --silent --show-error --max-time 5 \
    -H "Authorization: Bearer $PHASE6_PROBE_TOKEN" \
    "$PHASE6_API_BASE_URL$PHASE6_READ_PROBE_PATH"
  quiet curl --fail --silent --show-error --max-time 5 \
    -X POST -H "Authorization: Bearer $PHASE6_PROBE_TOKEN" \
    -H 'content-type: application/json' --data '{"probe":"phase6"}' \
    "$PHASE6_API_BASE_URL$PHASE6_WRITE_PROBE_PATH"
}

write_evidence() {
  local status="$1" mode="$2" external="$3" frozen="$4" candidate_boot="$5" previous_boot="$6" probes="$7"
  mkdir -p -- "$(dirname -- "$EVIDENCE_FILE")"
  PHASE6_EVIDENCE_FILE="$EVIDENCE_FILE" \
    PHASE6_MIGRATIONS_DIR="$MIGRATIONS_DIR" \
    PHASE6_STATUS="$status" \
    PHASE6_MODE="$mode" \
    PHASE6_EXTERNAL="$external" \
    PHASE6_FROZEN="$frozen" \
    PHASE6_CANDIDATE_BOOT="$candidate_boot" \
    PHASE6_PREVIOUS_BOOT="$previous_boot" \
    PHASE6_PROBES="$probes" \
    PHASE6_CANDIDATE_API_IMAGE="$PHASE6_CANDIDATE_API_IMAGE" \
    PHASE6_CANDIDATE_WEB_IMAGE="$PHASE6_CANDIDATE_WEB_IMAGE" \
    PHASE6_CANDIDATE_WORKER_IMAGE="$PHASE6_CANDIDATE_WORKER_IMAGE" \
    PHASE6_PREVIOUS_API_IMAGE="$PHASE6_PREVIOUS_API_IMAGE" \
    PHASE6_PREVIOUS_WEB_IMAGE="$PHASE6_PREVIOUS_WEB_IMAGE" \
    PHASE6_PREVIOUS_WORKER_IMAGE="$PHASE6_PREVIOUS_WORKER_IMAGE" \
    PHASE6_CANDIDATE_SOURCE_SHA="$PHASE6_CANDIDATE_SOURCE_SHA" \
    PHASE6_PREVIOUS_SOURCE_SHA="$PHASE6_PREVIOUS_RELEASE_SOURCE_SHA" \
    PHASE6_PREVIOUS_MANIFEST_SHA="$PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256" \
    node --input-type=module -e '
      import { createHash } from "node:crypto";
      import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
      import { dirname, join } from "node:path";
      const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
      const root = process.env.PHASE6_MIGRATIONS_DIR;
      const versions = ["0000","0001","0002","0003","0004","0005","0006","0007","0008","0009","0010","0011"];
      const artifacts = versions.map((version) => {
        const sqlPath = join(root, `${version}_${({
          "0000":"phase0_auth","0001":"phase2_workspaces","0002":"phase2_notes","0003":"phase2_rate_limits",
          "0004":"phase3_themes","0005":"phase5_jobs","0006":"phase5_assets","0007":"phase5_search",
          "0008":"phase5_exports","0009":"phase5_share_links","0010":"phase5_lifecycle","0011":"phase5_export_formats"
        })[version]}.sql`);
        const snapshotPath = join(root, "meta", `${version}_snapshot.json`);
        return { version, sqlSha256: hash(sqlPath), snapshotSha256: hash(snapshotPath) };
      });
      const journalSha256 = hash(join(root, "meta", "_journal.json"));
      const snapshotSha256 = createHash("sha256").update(artifacts.map((entry) => entry.snapshotSha256).join("\n")).digest("hex");
      const digest = (value) => value.slice(value.lastIndexOf("@") + 1);
      const boolean = (value) => value === "1";
      const evidence = {
        schemaVersion: 1,
        status: process.env.PHASE6_STATUS,
        scrubbed: true,
        target: "isolated",
        mode: process.env.PHASE6_MODE,
        externalEvidenceAvailable: boolean(process.env.PHASE6_EXTERNAL),
        candidate: { sourceSha: process.env.PHASE6_CANDIDATE_SOURCE_SHA, api: digest(process.env.PHASE6_CANDIDATE_API_IMAGE), web: digest(process.env.PHASE6_CANDIDATE_WEB_IMAGE), worker: digest(process.env.PHASE6_CANDIDATE_WORKER_IMAGE) },
        previous: { sourceSha: process.env.PHASE6_PREVIOUS_SOURCE_SHA, manifestSha256: process.env.PHASE6_PREVIOUS_MANIFEST_SHA, api: digest(process.env.PHASE6_PREVIOUS_API_IMAGE), web: digest(process.env.PHASE6_PREVIOUS_WEB_IMAGE), worker: digest(process.env.PHASE6_PREVIOUS_WORKER_IMAGE) },
        migration: { journalSha256, snapshotSha256, artifacts, frozenByteIdentical: boolean(process.env.PHASE6_FROZEN) },
        checks: { preflight: boolean(process.env.PHASE6_EXTERNAL), migration: boolean(process.env.PHASE6_EXTERNAL), candidateBoot: boolean(process.env.PHASE6_CANDIDATE_BOOT), previousBoot: boolean(process.env.PHASE6_PREVIOUS_BOOT), compatibility: boolean(process.env.PHASE6_PROBES), noHistoryRewrite: boolean(process.env.PHASE6_FROZEN) },
        probes: { read: boolean(process.env.PHASE6_PROBES), write: boolean(process.env.PHASE6_PROBES) },
        recordedAt: new Date().toISOString()
      };
      mkdirSync(dirname(process.env.PHASE6_EVIDENCE_FILE), { recursive: true, mode: 0o700 });
      writeFileSync(process.env.PHASE6_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    '
}

cleanup() {
  stop_services
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

[[ "$PHASE6_TARGET" == "isolated" ]] || fail "TARGET_MUST_BE_ISOLATED"
[[ "$PHASE6_DRY_RUN" == "0" || "$PHASE6_DRY_RUN" == "1" ]] || fail "DRY_RUN_INVALID"
require_database_target
require_object_target
require_release_identity
find_frozen_files

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/glyphquire-phase6-deploy.XXXXXX")"
before_hashes="$work_dir/frozen-before.sha256"
after_candidate_hashes="$work_dir/frozen-candidate.sha256"
after_previous_hashes="$work_dir/frozen-previous.sha256"
capture_frozen_hashes "$before_hashes"

if [[ "$PHASE6_DRY_RUN" == "1" ]]; then
  write_evidence blocked dry-run 0 1 0 0 0
  printf '{"event":"PHASE6_DEPLOYMENT_REHEARSAL","status":"blocked","target":"isolated","scrubbed":true}\n'
  exit 0
fi

run_database_preflight
run_object_preflight
capture_frozen_hashes "$after_candidate_hashes"
assert_frozen_hashes "$before_hashes" "$after_candidate_hashes"

start_services "$PHASE6_CANDIDATE_API_IMAGE" "$PHASE6_CANDIDATE_WEB_IMAGE" "$PHASE6_CANDIDATE_WORKER_IMAGE"
probe_services
capture_frozen_hashes "$after_candidate_hashes"
assert_frozen_hashes "$before_hashes" "$after_candidate_hashes"
stop_services

start_services "$PHASE6_PREVIOUS_API_IMAGE" "$PHASE6_PREVIOUS_WEB_IMAGE" "$PHASE6_PREVIOUS_WORKER_IMAGE"
probe_services
capture_frozen_hashes "$after_previous_hashes"
assert_frozen_hashes "$before_hashes" "$after_previous_hashes"

write_evidence passed compose 1 1 1 1 1
printf '{"event":"PHASE6_DEPLOYMENT_REHEARSAL","status":"passed","target":"isolated","scrubbed":true}\n'
