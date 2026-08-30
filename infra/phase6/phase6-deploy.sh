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
PHASE6_ISOLATED_CONFIRMATION="${PHASE6_ISOLATED_CONFIRMATION:-}"
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
  [[ "$PHASE6_ISOLATED_CONFIRMATION" == "isolated" ]] || fail "ISOLATED_CONFIRMATION_REQUIRED"
  [[ "$PHASE6_EXPECTED_DATABASE_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "DATABASE_HOST_NOT_CANONICAL"
  [[ "$PHASE6_EXPECTED_DATABASE_NAME" =~ ^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$ ]] || fail "DATABASE_NAME_NOT_CANONICAL"
  [[ ! "$PHASE6_EXPECTED_DATABASE_HOST" =~ (^|[.-])(prod|production|live|primary|main)([.-]|$) ]] || fail "DATABASE_HOST_NOT_ISOLATED"
  [[ ! "$PHASE6_EXPECTED_DATABASE_NAME" =~ (^|[_-])(prod|production|live|primary|main)([_-]|$) ]] || fail "DATABASE_NAME_NOT_ISOLATED"
  case "$PHASE6_EXPECTED_DATABASE_HOST" in
    localhost|127.0.0.1|*.example|*.test|*.local|*.internal) ;;
    *) fail "DATABASE_HOST_NOT_ISOLATED" ;;
  esac
  case "$PHASE6_EXPECTED_DATABASE_NAME" in
    glyphquire|glyphquire_*|phase6_*|*_test|*_drill) ;;
    *) fail "DATABASE_NAME_NOT_ISOLATED" ;;
  esac
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
declare -A frozen_sql_hashes=(
  [0000]=7fbba803d17ce335f8acc41fd7027c3c1278d4af79225c48ac6d0ab885028863
  [0001]=c0aac84d7bb3fd4766604dfa46d2f0df18b5b4f027e42e5ec6696e9386f1f162
  [0002]=7d4bb87aae2f390f35070ed3e696a92222d2613bef64de573f3314eddbae3f3c
  [0003]=6b612d6e34faad76b973a6fb0701168d28b34f78921be444c26e6485b3e61562
  [0004]=49cdc8578e087d7c20db0e5d3cd55d6a11fd33767892bebe278a6d8b2f8c169e
  [0005]=6891de73469132b56f1b9292ab2a2b4fcc73c29095ef5373c901adc3da13bdd8
  [0006]=8def4960a411f9f49fc1ee035065325bc9a5563bca2ac8d759c170e5a23b7285
  [0007]=5a764469e55745b1daffb4fcc66d7ebf54e08d8bea823192d71a0b1b6d42873a
  [0008]=9a6ad7ed95a5e65b0dc0e2daba5e3720c28e822752b32ff254565e754b42b14e
  [0009]=cad40a10a1f8649a73b60b45d4cd27b2c8e03771d323028a90c451eaa8385fab
  [0010]=a9dd8e0fb7640e1f19ec8aac42f5b1a6c414f1ee2be10ec1c8ee09f707afba21
  [0011]=b911d7eccb8482baa164898e5b9fbc359bdb79f23e480c82734ea7e68e4ea5be
)
declare -A frozen_snapshot_hashes=(
  [0000]=ddbdd01656f226667fc4e9b8533d946d8d57ed643d580ade86d4451a27c0be66
  [0001]=34bd5364fd4c17657b6caeaf1c6b04090274b1a01b04055c133c7fb384008519
  [0002]=22fdf50455abb0cf543b06165540062c8aa10086699b551e7c03991b869634ad
  [0003]=e55a4b78b66207d3139fbad6fe17257341ca3a89ba9949c33ee7cb613f724c2d
  [0004]=f93a9007498aa3aaa5d80c4814ee667c472d49d79241b214e6abf2d2dc95339b
  [0005]=589cc429233dabfabfcff97a416ab36d60194335ac7f7168a175b73e2108862a
  [0006]=9d0382bfaf90dee341d95f4f1c4d9e4b480705e94593aac9fe7ff84ce01b9280
  [0007]=c5f36fa27689bdf7ff6939d333cd81445b707b6960b7e5656f34ef1dfa8438a2
  [0008]=ded0f2c864ad7531011f6df4fc3a07a708a72e429b0b0bbc866bceb8a2ce73ef
  [0009]=def5267a8e12090d69f9caeff4bb86857f9094a46f6a044fa1417d4e0725c7f9
  [0010]=083f0d9e77c2c53d2135c6f34b6b1496ef16eef02477b6b09fa7bd9e5772e727
  [0011]=2e334c01d975eed6c0f12bc182ed47e3399c2ffb8c4d81583d385504ee6729f8
)
readonly frozen_journal_hash=a3662853e91dcea9d934506e3863365f5fb35d58b433e0db9b1d59389c9bffb5

expected_sql_names=(
  0000_phase0_auth.sql 0001_phase2_workspaces.sql 0002_phase2_notes.sql
  0003_phase2_rate_limits.sql 0004_phase3_themes.sql 0005_phase5_jobs.sql
  0006_phase5_assets.sql 0007_phase5_search.sql 0008_phase5_exports.sql
  0009_phase5_share_links.sql 0010_phase5_lifecycle.sql 0011_phase5_export_formats.sql
)

find_frozen_files() {
  local version sql_file snapshot_file actual expected
  command -v sha256sum >/dev/null 2>&1 || fail "SHA256SUM_MISSING"
  shopt -s nullglob
  [[ -d "$MIGRATIONS_DIR" ]] || fail "MIGRATIONS_DIRECTORY_MISSING"
  [[ -f "$MIGRATIONS_DIR/meta/_journal.json" ]] || fail "MIGRATION_JOURNAL_MISSING"
  [[ ! -L "$MIGRATIONS_DIR/meta/_journal.json" ]] || fail "MIGRATION_JOURNAL_SYMLINK"
  frozen_files=("$MIGRATIONS_DIR/meta/_journal.json")
  actual="$(sha256sum -- "$MIGRATIONS_DIR/meta/_journal.json" | awk '{print $1}')" || fail "MIGRATION_JOURNAL_HASH_FAILED"
  [[ "$actual" == "$frozen_journal_hash" ]] || fail "MIGRATION_JOURNAL_HASH_MISMATCH"

  local -a sql_names
  mapfile -t sql_names < <(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -name '*.sql' -printf '%f\n' | sort)
  ((${#sql_names[@]} == ${#expected_sql_names[@]})) || fail "FROZEN_MIGRATION_INVENTORY_MISMATCH"
  for sql_file in "${sql_names[@]}"; do
    [[ " ${expected_sql_names[*]} " == *" $sql_file "* ]] || fail "EXTRA_MIGRATION_ARTIFACT"
  done

  for version in "${frozen_versions[@]}"; do
    local sql_files=("$MIGRATIONS_DIR/${version}_"*.sql)
    ((${#sql_files[@]} == 1)) || fail "FROZEN_MIGRATION_${version}_INVALID"
    sql_file="${sql_files[0]}"
    snapshot_file="$MIGRATIONS_DIR/meta/${version}_snapshot.json"
    [[ -f "$sql_file" && ! -L "$sql_file" ]] || fail "FROZEN_MIGRATION_${version}_INVALID"
    [[ -f "$snapshot_file" ]] || fail "FROZEN_SNAPSHOT_${version}_MISSING"
    [[ ! -L "$snapshot_file" ]] || fail "FROZEN_ARTIFACT_SYMLINK"
    expected="${frozen_sql_hashes[$version]}"
    actual="$(sha256sum -- "$sql_file" | awk '{print $1}')" || fail "FROZEN_MIGRATION_HASH_FAILED"
    [[ "$actual" == "$expected" ]] || fail "FROZEN_MIGRATION_${version}_HASH_MISMATCH"
    expected="${frozen_snapshot_hashes[$version]}"
    actual="$(sha256sum -- "$snapshot_file" | awk '{print $1}')" || fail "FROZEN_SNAPSHOT_${version}_HASH_FAILED"
    [[ "$actual" == "$expected" ]] || fail "FROZEN_SNAPSHOT_${version}_HASH_MISMATCH"
    frozen_files+=("$sql_file" "$snapshot_file")
  done

  local -a meta_names
  mapfile -t meta_names < <(find "$MIGRATIONS_DIR/meta" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
  ((${#meta_names[@]} == 13)) || fail "FROZEN_METADATA_INVENTORY_MISMATCH"
  [[ " ${meta_names[*]} " == *" _journal.json "* ]] || fail "MIGRATION_JOURNAL_NOT_CANONICAL"
  for version in "${frozen_versions[@]}"; do
    [[ " ${meta_names[*]} " == *" ${version}_snapshot.json "* ]] || fail "FROZEN_SNAPSHOT_${version}_MISSING"
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
