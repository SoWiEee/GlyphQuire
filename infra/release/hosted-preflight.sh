#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly ENV_FILE="${RELEASE_HOSTED_ENV_FILE:-}"
readonly BASE_URL="${RELEASE_HOSTED_BASE_URL:-}"
readonly PREFLIGHT_PATH="${RELEASE_HOSTED_PREFLIGHT_PATH:-}"
readonly EVIDENCE_FILE="${RELEASE_HOSTED_EVIDENCE_FILE:-}"
temporary_root=""

fail() {
  printf 'RELEASE_HOSTED_PREFLIGHT_FAILED:%s\n' "${1:-CHECK_FAILED}" >&2
  exit 2
}

skip_external() {
  printf 'SKIPPED_EXTERNAL: %s\n' "${1:-external hosted target is unavailable}" >&2
  exit 2
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || skip_external "${name}_MISSING"
}

valid_sha256() {
  [[ "${1:-}" =~ ^[a-f0-9]{64}$ ]]
}

valid_image_digest() {
  [[ "${1:-}" =~ ^sha256:[a-f0-9]{64}$ ]]
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

load_vault_file() {
  [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] || skip_external "ENV_FILE_MISSING"
  [[ ! -L "$ENV_FILE" ]] || fail "ENV_FILE_MUST_NOT_BE_SYMLINK"
  local line key value
  local -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || fail "ENV_FILE_FORMAT_INVALID"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case "$key" in
      RELEASE_HOSTED_DATABASE_URL|RELEASE_HOSTED_MIGRATION_DATABASE_URL|RELEASE_HOSTED_S3_ENDPOINT|RELEASE_HOSTED_S3_ACCESS_KEY|RELEASE_HOSTED_S3_SECRET_KEY|RELEASE_HOSTED_S3_BUCKET|RELEASE_HOSTED_PROBE_TOKEN) ;;
      *) fail "ENV_FILE_KEY_NOT_ALLOWED" ;;
    esac
    [[ -z "${seen[$key]:-}" ]] || fail "ENV_FILE_DUPLICATE_KEY"
    seen[$key]=1
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then value="${value:1:${#value}-2}"; fi
    if [[ "$value" == \'*\' && "$value" == *\' ]]; then value="${value:1:${#value}-2}"; fi
    [[ "$value" != *$'\n'* ]] || fail "ENV_FILE_VALUE_INVALID"
    printf -v "$key" '%s' "$value"
  done <"$ENV_FILE"

  local key_name
  for key_name in \
    RELEASE_HOSTED_DATABASE_URL RELEASE_HOSTED_MIGRATION_DATABASE_URL \
    RELEASE_HOSTED_S3_ENDPOINT RELEASE_HOSTED_S3_ACCESS_KEY \
    RELEASE_HOSTED_S3_SECRET_KEY RELEASE_HOSTED_S3_BUCKET RELEASE_HOSTED_PROBE_TOKEN; do
    require_value "$key_name"
  done
}

require_expected_values() {
  require_value RELEASE_HOSTED_BASE_URL
  require_value RELEASE_HOSTED_PREFLIGHT_PATH
  require_value RELEASE_EXPECTED_RUNTIME_ROLE
  require_value RELEASE_EXPECTED_MIGRATION_ROLE
  require_value RELEASE_EXPECTED_WORKER_ID
  require_value RELEASE_EXPECTED_BUCKET
  require_value RELEASE_EXPECTED_IMAGE_DIGEST
  require_value RELEASE_EXPECTED_MIGRATION_JOURNAL_SHA
  [[ "$BASE_URL" == "$RELEASE_HOSTED_BASE_URL" ]] || fail "BASE_URL_CHANGED"
  [[ "$PREFLIGHT_PATH" == "$RELEASE_HOSTED_PREFLIGHT_PATH" ]] || fail "PREFLIGHT_PATH_CHANGED"
  [[ "$BASE_URL" =~ ^https://[^/@?#]+$ ]] || fail "BASE_URL_INVALID"
  [[ "$PREFLIGHT_PATH" == /api/internal/release/preflight ]] || fail "PREFLIGHT_PATH_INVALID"
  [[ "$RELEASE_EXPECTED_RUNTIME_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "RUNTIME_ROLE_INVALID"
  [[ "$RELEASE_EXPECTED_MIGRATION_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "MIGRATION_ROLE_INVALID"
  [[ "$RELEASE_EXPECTED_RUNTIME_ROLE" != "$RELEASE_EXPECTED_MIGRATION_ROLE" ]] || fail "ROLES_NOT_SEPARATE"
  [[ "$RELEASE_EXPECTED_WORKER_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "WORKER_ID_INVALID"
  [[ "$RELEASE_EXPECTED_BUCKET" =~ ^[a-z0-9](\.?[a-z0-9-]+)*$ ]] || fail "BUCKET_INVALID"
  valid_image_digest "$RELEASE_EXPECTED_IMAGE_DIGEST" || fail "IMAGE_DIGEST_INVALID"
  valid_sha256 "$RELEASE_EXPECTED_MIGRATION_JOURNAL_SHA" || fail "MIGRATION_JOURNAL_SHA_INVALID"
  [[ "$RELEASE_HOSTED_S3_BUCKET" == "$RELEASE_EXPECTED_BUCKET" ]] || fail "BUCKET_MISMATCH"
}

require_database_identity() {
  local runtime_user runtime_host runtime_name
  local migration_user migration_host migration_name
  parse_database_url "$RELEASE_HOSTED_DATABASE_URL" runtime_user runtime_host runtime_name || fail "DATABASE_URL_INVALID"
  parse_database_url "$RELEASE_HOSTED_MIGRATION_DATABASE_URL" migration_user migration_host migration_name || fail "MIGRATION_DATABASE_URL_INVALID"
  [[ "$runtime_host" == "$migration_host" && "$runtime_name" == "$migration_name" ]] || fail "DATABASE_TARGETS_NOT_CANONICAL"
  [[ "$runtime_user" == "$RELEASE_EXPECTED_RUNTIME_ROLE" ]] || fail "RUNTIME_ROLE_MISMATCH"
  [[ "$migration_user" == "$RELEASE_EXPECTED_MIGRATION_ROLE" ]] || fail "MIGRATION_ROLE_MISMATCH"
  [[ "$runtime_user" != "$migration_user" ]] || fail "ROLES_NOT_SEPARATE"
  [[ "$RELEASE_HOSTED_S3_ENDPOINT" =~ ^https://[^/@?#]+(:[0-9]+)?$ ]] || fail "S3_ENDPOINT_INVALID"
}

run_database_checks() {
  command -v psql >/dev/null 2>&1 || skip_external "PSQL_MISSING"
  local actual_runtime_role actual_migration_role
  if ! actual_runtime_role="$(psql "$RELEASE_HOSTED_DATABASE_URL" -Atqc 'select current_user' 2>/dev/null)"; then
    fail "RUNTIME_DATABASE_UNAVAILABLE"
  fi
  if ! actual_migration_role="$(psql "$RELEASE_HOSTED_MIGRATION_DATABASE_URL" -Atqc 'select current_user' 2>/dev/null)"; then
    fail "MIGRATION_DATABASE_UNAVAILABLE"
  fi
  [[ "$actual_runtime_role" == "$RELEASE_EXPECTED_RUNTIME_ROLE" ]] || fail "RUNTIME_ROLE_CHECK_FAILED"
  [[ "$actual_migration_role" == "$RELEASE_EXPECTED_MIGRATION_ROLE" ]] || fail "MIGRATION_ROLE_CHECK_FAILED"
  psql "$RELEASE_HOSTED_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f \
    "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/../postgres/upgrade/002_role_preflight.sql" \
    >/dev/null 2>&1 || fail "ROLE_PREFLIGHT_FAILED"
}

run_object_storage_check() {
  command -v aws >/dev/null 2>&1 || skip_external "AWS_CLI_MISSING"
  AWS_ACCESS_KEY_ID="$RELEASE_HOSTED_S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$RELEASE_HOSTED_S3_SECRET_KEY" \
    AWS_ENDPOINT_URL="$RELEASE_HOSTED_S3_ENDPOINT" \
    aws s3api head-bucket --bucket "$RELEASE_EXPECTED_BUCKET" >/dev/null 2>&1 \
    || fail "OBJECT_STORAGE_CHECK_FAILED"
}

call_http_checks() {
  command -v curl >/dev/null 2>&1 || skip_external "CURL_MISSING"
  temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/glyphquire-release-hosted.XXXXXX")"
  local health_body="$temporary_root/health"
  local readiness_body="$temporary_root/readiness"
  local preflight_body="$temporary_root/preflight"
  curl --fail --silent --show-error --max-time 5 "$BASE_URL/api/health" >"$health_body" 2>/dev/null \
    || fail "HEALTH_CHECK_FAILED"
  curl --fail --silent --show-error --max-time 5 "$BASE_URL/api/ready" >"$readiness_body" 2>/dev/null \
    || fail "READINESS_CHECK_FAILED"
  curl --fail --silent --show-error --max-time 5 \
    -H "Authorization: Bearer $RELEASE_HOSTED_PROBE_TOKEN" \
    "$BASE_URL$PREFLIGHT_PATH" >"$preflight_body" 2>/dev/null \
    || fail "INTERNAL_PREFLIGHT_FAILED"
  RELEASE_PREFLIGHT_BODY="$preflight_body" \
    RELEASE_EXPECTED_RUNTIME_ROLE="$RELEASE_EXPECTED_RUNTIME_ROLE" \
    RELEASE_EXPECTED_MIGRATION_ROLE="$RELEASE_EXPECTED_MIGRATION_ROLE" \
    RELEASE_EXPECTED_WORKER_ID="$RELEASE_EXPECTED_WORKER_ID" \
    RELEASE_EXPECTED_BUCKET="$RELEASE_EXPECTED_BUCKET" \
    RELEASE_EXPECTED_IMAGE_DIGEST="$RELEASE_EXPECTED_IMAGE_DIGEST" \
    RELEASE_EXPECTED_MIGRATION_JOURNAL_SHA="$RELEASE_EXPECTED_MIGRATION_JOURNAL_SHA" \
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const body = JSON.parse(readFileSync(process.env.RELEASE_PREFLIGHT_BODY, "utf8"));
      const checks = ["health", "readiness", "database", "objectStorage", "roles", "worker", "image", "migrationJournal"];
      if (body.ok !== true || !body.checks || !checks.every((key) => body.checks[key] === true)) process.exit(1);
      const expected = body.expected;
      if (!expected || expected.runtimeRole !== process.env.RELEASE_EXPECTED_RUNTIME_ROLE || expected.migrationRole !== process.env.RELEASE_EXPECTED_MIGRATION_ROLE || expected.workerId !== process.env.RELEASE_EXPECTED_WORKER_ID || expected.bucket !== process.env.RELEASE_EXPECTED_BUCKET || expected.imageDigest !== process.env.RELEASE_EXPECTED_IMAGE_DIGEST || expected.migrationJournalSha !== process.env.RELEASE_EXPECTED_MIGRATION_JOURNAL_SHA) process.exit(1);
    ' >/dev/null 2>&1 || fail "INTERNAL_PREFLIGHT_CHECK_FAILED"
}

write_evidence() {
  [[ -n "$EVIDENCE_FILE" ]] || return 0
  mkdir -p -- "$(dirname -- "$EVIDENCE_FILE")"
  RELEASE_HOSTED_EVIDENCE_FILE="$EVIDENCE_FILE" \
    RELEASE_EXPECTED_RUNTIME_ROLE="$RELEASE_EXPECTED_RUNTIME_ROLE" \
    RELEASE_EXPECTED_MIGRATION_ROLE="$RELEASE_EXPECTED_MIGRATION_ROLE" \
    RELEASE_EXPECTED_WORKER_ID="$RELEASE_EXPECTED_WORKER_ID" \
    RELEASE_EXPECTED_BUCKET="$RELEASE_EXPECTED_BUCKET" \
    RELEASE_EXPECTED_IMAGE_DIGEST="$RELEASE_EXPECTED_IMAGE_DIGEST" \
    RELEASE_EXPECTED_MIGRATION_JOURNAL_SHA="$RELEASE_EXPECTED_MIGRATION_JOURNAL_SHA" \
    node --input-type=module -e '
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      const evidence = { event: "RELEASE_HOSTED_PREFLIGHT", status: "passed", scrubbed: true, checks: { health: true, readiness: true, database: true, objectStorage: true, roles: true, worker: true, image: true, migrationJournal: true }, expected: { runtimeRole: process.env.RELEASE_EXPECTED_RUNTIME_ROLE, migrationRole: process.env.RELEASE_EXPECTED_MIGRATION_ROLE, workerId: process.env.RELEASE_EXPECTED_WORKER_ID, bucket: process.env.RELEASE_EXPECTED_BUCKET, imageDigest: process.env.RELEASE_EXPECTED_IMAGE_DIGEST, migrationJournalSha: process.env.RELEASE_EXPECTED_MIGRATION_JOURNAL_SHA }, recordedAt: new Date().toISOString() };
      mkdirSync(dirname(process.env.RELEASE_HOSTED_EVIDENCE_FILE), { recursive: true, mode: 0o700 });
      writeFileSync(process.env.RELEASE_HOSTED_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    '
}

cleanup() {
  if [[ -n "$temporary_root" && -d "$temporary_root" ]]; then rm -rf -- "$temporary_root"; fi
}
trap cleanup EXIT

load_vault_file
require_expected_values
require_database_identity
run_database_checks
run_object_storage_check
call_http_checks
write_evidence
printf '{"event":"RELEASE_HOSTED_PREFLIGHT","status":"passed","scrubbed":true}\n'
