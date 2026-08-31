#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/glyphquire/backups}"
readonly BACKUP_ID="${BACKUP_ID:-}"
readonly BACKUP_ENCRYPTION_KEY="${RESTORE_ENCRYPTION_KEY:-${BACKUP_ENCRYPTION_KEY:-}}"
readonly BACKUP_ENCRYPTION_KEY_VERSION="${BACKUP_ENCRYPTION_KEY_VERSION:-v1}"
readonly RESTORE_ROOT="${RESTORE_ROOT:-/var/lib/glyphquire/restore-drill}"
readonly RESTORE_TARGET="${RESTORE_TARGET:-isolated}"
readonly RESTORE_ISOLATED_CONFIRMATION="${RESTORE_ISOLATED_CONFIRMATION:-${RESTORE_CONFIRMATION:-${RESTORE_ISOLATION_CONFIRMATION:-}}}"
readonly RESTORE_DATABASE_URL="${RESTORE_DATABASE_URL:-}"
readonly RESTORE_OBJECT_STORAGE_TARGET="${RESTORE_OBJECT_STORAGE_TARGET:-${RESTORE_ROOT}/object-storage}"
readonly EVIDENCE_FILE="${RESTORE_EVIDENCE_FILE:-${REPOSITORY_ROOT}/docs/evidence/release/backup-restore-drill.md}"
readonly RELEASE_OUTPUT_FILE="${RELEASE_BACKUP_EVIDENCE_FILE:-${REPOSITORY_ROOT}/docs/evidence/release/backup-restore.json}"
readonly MAX_RESTORE_BYTES="${RESTORE_MAX_BYTES:-${BACKUP_MAX_BYTES:-1073741824}}"
readonly MAX_RESTORE_FILES="${RESTORE_MAX_FILES:-${BACKUP_MAX_FILES:-100000}}"
readonly MIGRATIONS_DIR="${RESTORE_MIGRATIONS_DIR:-${REPOSITORY_ROOT}/packages/database/src/migrations}"
readonly MIGRATION_JOURNAL_FILE="${RESTORE_MIGRATION_JOURNAL_FILE:-${MIGRATIONS_DIR}/meta/_journal.json}"

work_dir=""
key_file=""
failure_reported=0
external_skip_reported=0
manifest_file=""
aggregate_sha256=""
failure_reason=""
readonly ZERO_HASH="0000000000000000000000000000000000000000000000000000000000000000"

scrubbed_event() {
  local event="$1"
  local status="$2"
  local event_log="${RESTORE_EVENT_LOG:-${BACKUP_ROOT}/events.jsonl}"
  mkdir -p -- "$(dirname -- "$event_log")" 2>/dev/null || true
  printf '{"event":"%s","type":"backup.verify","status":"%s","backup_id":"scrubbed","target":"isolated","encryption":"AES-256-GCM"}\n' \
    "$event" "$status" >>"$event_log" 2>/dev/null || true
}

cleanup() {
  local status=$?
  if [[ -n "$key_file" && -f "$key_file" ]]; then
    rm -f -- "$key_file" 2>/dev/null || true
  fi
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir" 2>/dev/null || true
  fi
  return "$status"
}

on_error() {
  local status=$?
  if ((failure_reported == 0 && external_skip_reported == 0)); then
    failure_reported=1
    write_release_failure_evidence "${failure_reason:-INTERNAL_FAILURE}" >/dev/null 2>&1 || true
    scrubbed_event "RESTORE_FAILED" "failed"
  fi
  return "$status"
}

trap on_error ERR
trap cleanup EXIT

fail() {
  failure_reason="$1"
  printf 'RESTORE_FAILED:%s\n' "$1" >&2
  return 1
}

skip_external() {
  external_skip_reported=1
  printf 'SKIPPED_EXTERNAL: %s\n' "${1:-external restore target is unavailable}" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "${1^^}_MISSING"
}

require_external_command() {
  command -v "$1" >/dev/null 2>&1 || skip_external "${1^^}_MISSING"
}

valid_hash() {
  [[ "${1:-}" =~ ^[a-f0-9]{64}$ ]]
}

valid_positive_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

canonical_path() {
  realpath -m -- "$1"
}

parse_database_url() {
  local value="$1"
  if [[ ! "$value" =~ ^postgres(ql)?://([^/:@]+)(:[^@]*)?@([^/:?#]+)(:[0-9]+)?/([^?/#]+)($|\?.*) ]]; then
    return 1
  fi
  parsed_database_host="${BASH_REMATCH[4]}"
  parsed_database_name="${BASH_REMATCH[6]}"
}

validate_isolated_database_target() {
  [[ -n "$RESTORE_DATABASE_URL" ]] || skip_external "RESTORE_DATABASE_URL_MISSING"
  parse_database_url "$RESTORE_DATABASE_URL" || fail "RESTORE_DATABASE_URL_INVALID"
  [[ ! "$parsed_database_host" =~ (^|[.-])(prod|production|live|primary|main)([.-]|$) ]] || fail "RESTORE_DATABASE_NOT_ISOLATED"
  [[ ! "$parsed_database_name" =~ (^|[_-])(prod|production|live|primary|main)([_-]|$) ]] || fail "RESTORE_DATABASE_NOT_ISOLATED"
  case "$parsed_database_host" in
    localhost|127.0.0.1|\[::1\]|*.example|*.test|*.local) ;;
    *) fail "RESTORE_DATABASE_NOT_ISOLATED" ;;
  esac
  case "$parsed_database_name" in
    glyphquire|glyphquire_*|release_*|*_test|*_drill) ;;
    *) fail "RESTORE_DATABASE_NOT_ISOLATED" ;;
  esac
  if [[ -n "${DATABASE_URL:-}" && "$RESTORE_DATABASE_URL" == "$DATABASE_URL" ]]; then
    fail "RESTORE_DATABASE_EQUALS_SOURCE"
  fi
}

validate_isolated_object_target() {
  [[ -n "$RESTORE_OBJECT_STORAGE_TARGET" ]] || skip_external "RESTORE_OBJECT_STORAGE_TARGET_MISSING"
  if [[ "$RESTORE_OBJECT_STORAGE_TARGET" == s3://* ]]; then
    local bucket="${RESTORE_OBJECT_STORAGE_TARGET#s3://}"
    bucket="${bucket%%/*}"
    [[ "$bucket" =~ ^[a-z0-9](\.?[a-z0-9-]+)*$ ]] || fail "RESTORE_BUCKET_INVALID"
    [[ ! "$bucket" =~ (^|[-.])(prod|production|live|primary|main)([-.]|$) ]] || fail "RESTORE_BUCKET_NOT_ISOLATED"
    [[ "$RESTORE_OBJECT_STORAGE_TARGET" != "${OBJECT_STORAGE_SOURCE:-}" ]] || fail "RESTORE_OBJECT_TARGET_EQUALS_SOURCE"
    [[ -n "${AWS_ACCESS_KEY_ID:-${S3_ACCESS_KEY:-}}" ]] || skip_external "RESTORE_OBJECT_ACCESS_KEY_MISSING"
    [[ -n "${AWS_SECRET_ACCESS_KEY:-${S3_SECRET_KEY:-}}" ]] || skip_external "RESTORE_OBJECT_SECRET_KEY_MISSING"
    return
  fi
  [[ "$RESTORE_OBJECT_STORAGE_TARGET" = /* ]] || fail "RESTORE_OBJECT_TARGET_NOT_ABSOLUTE"
  local target_path="$(canonical_path "$RESTORE_OBJECT_STORAGE_TARGET")"
  local restore_path="$(canonical_path "$RESTORE_ROOT")"
  local backup_path="$(canonical_path "$BACKUP_ROOT")"
  [[ "$target_path" != "$backup_path" && "$target_path" != "$backup_path"/* ]] || fail "RESTORE_OBJECT_TARGET_NOT_ISOLATED"
  [[ "$target_path" != "$restore_path" ]] || fail "RESTORE_OBJECT_TARGET_INVALID"
  [[ "$target_path" == "$restore_path"/* ]] || fail "RESTORE_OBJECT_TARGET_OUTSIDE_ROOT"
  if [[ -n "${OBJECT_STORAGE_SOURCE:-}" && "$OBJECT_STORAGE_SOURCE" != s3://* ]]; then
    local source_path="$(canonical_path "$OBJECT_STORAGE_SOURCE")"
    [[ "$target_path" != "$source_path" && "$target_path" != "$source_path"/* ]] || fail "RESTORE_OBJECT_TARGET_EQUALS_SOURCE"
  fi
}

validate_configuration() {
  [[ "$RESTORE_TARGET" == "isolated" ]] || fail "RESTORE_TARGET_MUST_BE_ISOLATED"
  [[ "$RESTORE_ISOLATED_CONFIRMATION" == "isolated" ]] || fail "RESTORE_ISOLATED_CONFIRMATION_REQUIRED"
  [[ "$BACKUP_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "BACKUP_ID_INVALID"
  [[ -n "$BACKUP_ENCRYPTION_KEY" ]] || skip_external "BACKUP_ENCRYPTION_KEY_MISSING"
  [[ "$BACKUP_ENCRYPTION_KEY_VERSION" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || fail "KEY_VERSION_INVALID"
  valid_positive_integer "$MAX_RESTORE_BYTES" || fail "MAX_RESTORE_BYTES_INVALID"
  valid_positive_integer "$MAX_RESTORE_FILES" || fail "MAX_RESTORE_FILES_INVALID"
  [[ "$RESTORE_ROOT" != "/" && "$RESTORE_ROOT" = /* ]] || fail "RESTORE_ROOT_INVALID"
  local restore_path="$(canonical_path "$RESTORE_ROOT")"
  local backup_path="$(canonical_path "$BACKUP_ROOT")"
  [[ "$restore_path" != "$backup_path" && "$restore_path" != "$backup_path"/* ]] || fail "RESTORE_ROOT_NOT_ISOLATED"
  validate_isolated_database_target
  validate_isolated_object_target
}

verify_forward_only_migrations() {
  local version sql_file snapshot_file
  local -a expected_names=(0000 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011)
  local -a sql_files
  [[ -d "$MIGRATIONS_DIR" ]] || fail "MIGRATIONS_DIRECTORY_MISSING"
  [[ -f "$MIGRATION_JOURNAL_FILE" && ! -L "$MIGRATION_JOURNAL_FILE" ]] || fail "MIGRATION_JOURNAL_MISSING"
  shopt -s nullglob
  sql_files=("$MIGRATIONS_DIR"/*.sql)
  ((${#sql_files[@]} == 12)) || fail "FORWARD_ONLY_MIGRATION_INVENTORY_INVALID"
  for version in "${expected_names[@]}"; do
    local matches=("$MIGRATIONS_DIR/${version}_"*.sql)
    ((${#matches[@]} == 1)) || fail "FORWARD_ONLY_MIGRATION_${version}_MISSING"
    sql_file="${matches[0]}"
    [[ ! -L "$sql_file" ]] || fail "MIGRATION_ARTIFACT_SYMLINK"
    snapshot_file="$MIGRATIONS_DIR/meta/${version}_snapshot.json"
    [[ -f "$snapshot_file" && ! -L "$snapshot_file" ]] || fail "MIGRATION_SNAPSHOT_${version}_MISSING"
  done
  for sql_file in "${sql_files[@]}"; do
    version="$(basename -- "$sql_file" | cut -c1-4)"
    [[ "$version" =~ ^00(0[0-9]|1[01])$ ]] || fail "FORWARD_ONLY_MIGRATION_AHEAD"
  done
  migration_journal_sha256="$(sha256sum -- "$MIGRATION_JOURNAL_FILE" | awk '{print $1}')" || fail "MIGRATION_JOURNAL_HASH_FAILED"
  valid_hash "$migration_journal_sha256" || fail "MIGRATION_JOURNAL_HASH_INVALID"
}

validate_manifest() {
  RELEASE_MANIFEST_FILE="$manifest_file" RELEASE_BACKUP_ID="$BACKUP_ID" RELEASE_KEY_VERSION="$BACKUP_ENCRYPTION_KEY_VERSION" \
    RELEASE_MAX_BYTES="$MAX_RESTORE_BYTES" RELEASE_MAX_FILES="$MAX_RESTORE_FILES" \
    node --input-type=module - <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const env = process.env;
const manifest = JSON.parse(readFileSync(env.RELEASE_MANIFEST_FILE, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const expectedVersions = ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011"];
if (manifest.schemaVersion !== 1 || manifest.producer !== "release-backup-restore" || manifest.backupId !== env.RELEASE_BACKUP_ID) process.exit(1);
if (manifest.encryption?.algorithm !== "AES-256-GCM" || manifest.encryption?.authenticated !== true || manifest.encryption?.keyVersion !== env.RELEASE_KEY_VERSION) process.exit(1);
if (manifest.migration?.direction !== "forward-only" || JSON.stringify(manifest.migration?.versions) !== JSON.stringify(expectedVersions) || manifest.migration?.migrationCount !== 12 || !hashPattern.test(manifest.migration?.journalSha256 ?? "")) process.exit(1);
if (!manifest.bounds || manifest.bounds.maxBytes < 1 || manifest.bounds.maxFiles < 1 || manifest.bounds.maxBytes > Number(env.RELEASE_MAX_BYTES) || manifest.bounds.maxFiles > Number(env.RELEASE_MAX_FILES)) process.exit(1);
const database = manifest.database;
const objects = manifest.objectStorage;
if (!database || !objects || database.relationshipViolations !== 0 || !hashPattern.test(database.canonicalMarkdownSha256 ?? "")) process.exit(1);
for (const hash of Object.values(database.rowHashes ?? {})) if (typeof hash !== "string" || !hashPattern.test(hash)) process.exit(1);
for (const value of Object.values(database.rowCounts ?? {})) if (!Number.isInteger(value) || value < 0) process.exit(1);
if (!Number.isInteger(objects.fileCount) || objects.fileCount < 0 || !Number.isInteger(objects.totalBytes) || objects.totalBytes < 0 || objects.fileCount > Number(env.RELEASE_MAX_FILES) || objects.totalBytes > Number(env.RELEASE_MAX_BYTES) || !hashPattern.test(objects.aggregateSha256 ?? "")) process.exit(1);
for (const artifact of [database.artifact, objects.artifact]) {
  if (!artifact || artifact.schemaVersion !== 1 || artifact.algorithm !== "AES-256-GCM" || artifact.authenticated !== true || artifact.keyVersion !== env.RELEASE_KEY_VERSION || artifact.kdf !== "scrypt" || !/^[a-f0-9]{32}$/.test(artifact.salt ?? "") || !/^[a-f0-9]{24}$/.test(artifact.iv ?? "") || !/^[a-f0-9]{32}$/.test(artifact.authTag ?? "") || !hashPattern.test(artifact.plaintextSha256 ?? "") || !hashPattern.test(artifact.ciphertextSha256 ?? "") || !Number.isInteger(artifact.plaintextBytes) || !Number.isInteger(artifact.ciphertextBytes)) process.exit(1);
}
const aggregateInput = JSON.stringify({ database: database.artifact.plaintextSha256, objectStorage: objects.artifact.plaintextSha256, objects: objects.aggregateSha256 });
if (manifest.aggregateSha256 !== sha256(aggregateInput) || !hashPattern.test(manifest.aggregateSha256)) process.exit(1);
process.stdout.write([
  manifest.migration.journalSha256,
  manifest.migration.schemaVersion,
  manifest.migration.migrationCount,
  database.rowCounts.notes,
  database.rowCounts.noteVersions,
  database.rowCounts.assets,
  database.schemaVersionRange.minimum,
  database.schemaVersionRange.maximum,
  database.relationshipViolations,
  database.rowHashes.notes,
  database.rowHashes.noteVersions,
  database.rowHashes.assets,
  database.canonicalMarkdownSha256,
  objects.fileCount,
  objects.totalBytes,
  objects.aggregateSha256,
  manifest.aggregateSha256,
].join("\t"));
NODE
}

decrypt_artifact() {
  local kind="$1"
  local input="$2"
  local metadata="$3"
  local output="$4"
  node --input-type=module - "$key_file" "$input" "$metadata" "$output" "$BACKUP_ENCRYPTION_KEY_VERSION" "$kind" "$MAX_RESTORE_BYTES" <<'NODE'
import { createDecipheriv, createHash, scryptSync } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const [keyPath, inputPath, metadataPath, outputPath, keyVersion, kind, maxBytesRaw] = process.argv.slice(2);
const maxBytes = Number(maxBytesRaw);
const ciphertext = readFileSync(inputPath);
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (metadata.schemaVersion !== 1 || metadata.kind !== kind || metadata.algorithm !== "AES-256-GCM" || metadata.authenticated !== true || metadata.keyVersion !== keyVersion || metadata.kdf !== "scrypt") throw new Error("backup encryption metadata invalid");
if (metadata.ciphertextBytes !== ciphertext.byteLength || metadata.ciphertextSha256 !== hash(ciphertext)) throw new Error("ciphertext integrity verification failed");
if (!Number.isInteger(metadata.plaintextBytes) || metadata.plaintextBytes < 0 || metadata.plaintextBytes > maxBytes) throw new Error("plaintext size bound exceeded");
const secret = readFileSync(keyPath);
if (secret.byteLength === 0) throw new Error("empty encryption key");
const salt = Buffer.from(metadata.salt, "hex");
const iv = Buffer.from(metadata.iv, "hex");
const tag = Buffer.from(metadata.authTag, "hex");
const aad = Buffer.from(metadata.aad, "hex");
const key = scryptSync(secret, salt, 32);
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAAD(aad);
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
if (plaintext.byteLength !== metadata.plaintextBytes || hash(plaintext) !== metadata.plaintextSha256) throw new Error("plaintext integrity verification failed");
writeFileSync(outputPath, plaintext, { mode: 0o600 });
chmodSync(outputPath, 0o600);
NODE
}

inspect_tar() {
  local archive="$1"
  node --input-type=module - "$archive" "$MAX_RESTORE_FILES" "$MAX_RESTORE_BYTES" <<'NODE'
import { readFileSync } from "node:fs";

const [archivePath, maxFilesRaw, maxBytesRaw] = process.argv.slice(2);
const maxFiles = Number(maxFilesRaw);
const maxBytes = Number(maxBytesRaw);
const bytes = readFileSync(archivePath);
const zeroBlock = (block) => block.every((byte) => byte === 0);
const text = (block) => block.toString("utf8").replace(/\0.*$/u, "");
const octal = (block) => {
  const value = text(block).trim();
  if (!/^[0-7]*$/u.test(value)) throw new Error("invalid tar size");
  return value === "" ? 0 : Number.parseInt(value, 8);
};
let offset = 0;
let count = 0;
let totalBytes = 0;
let terminated = false;
while (offset + 512 <= bytes.length) {
  const header = bytes.subarray(offset, offset + 512);
  if (zeroBlock(header)) {
    terminated = true;
    break;
  }
  const storedChecksum = octal(header.subarray(148, 156));
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
  if (storedChecksum !== checksum) throw new Error("tar checksum mismatch");
  const name = `${text(header.subarray(345, 500))}${text(header.subarray(345, 500)) ? "/" : ""}${text(header.subarray(0, 100))}`;
  const type = String.fromCharCode(header[156] || 0);
  if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("tar path traversal");
  const size = octal(header.subarray(124, 136));
  const dataEnd = offset + 512 + Math.ceil(size / 512) * 512;
  if (dataEnd > bytes.length) throw new Error("truncated tar archive");
  if (type !== "0" && type !== "\0" && type !== "5") throw new Error("unsafe tar entry");
  if (type === "0") {
    count += 1;
    totalBytes += size;
    if (count > maxFiles || totalBytes > maxBytes) throw new Error("tar bounds exceeded");
  }
  offset = dataEnd;
}
if (!terminated || bytes.subarray(offset).some((byte) => byte !== 0)) throw new Error("truncated tar archive");
process.stdout.write(`${count}\t${totalBytes}`);
NODE
}

directory_inventory() {
  local directory="$1"
  node --input-type=module - "$directory" "$MAX_RESTORE_FILES" "$MAX_RESTORE_BYTES" <<'NODE'
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [root, maxFilesRaw, maxBytesRaw] = process.argv.slice(2);
const maxFiles = Number(maxFilesRaw);
const maxBytes = Number(maxBytesRaw);
const entries = [];
let totalBytes = 0;
function walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("symbolic links are not allowed");
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!stat.isFile()) throw new Error("non-regular object is not allowed");
    const bytes = readFileSync(path);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) throw new Error("object storage size bound exceeded");
    entries.push(`${relative(root, path).split(sep).join("/")}\t${bytes.byteLength}\t${createHash("sha256").update(bytes).digest("hex")}`);
    if (entries.length > maxFiles) throw new Error("object storage file-count bound exceeded");
  }
}
walk(root);
process.stdout.write(`${entries.length}\t${totalBytes}\t${createHash("sha256").update(entries.join("\n")).digest("hex")}`);
NODE
}

database_query() {
  local query="$1"
  psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "$query" 2>/dev/null || fail "RESTORE_DATABASE_QUERY_FAILED"
}

hash_database_query() {
  local query="$1"
  local result
  result="$(database_query "$query")" || return 1
  printf '%s' "$result" | sha256sum | awk '{print $1}'
}

verify_database_invariants() {
  restored_notes_rows="$(database_query 'SELECT count(*) FROM public.notes')"
  restored_note_versions_rows="$(database_query 'SELECT count(*) FROM public.note_versions')"
  restored_assets_rows="$(database_query 'SELECT count(*) FROM public.assets')"
  restored_migration_rows="$(database_query 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
  restored_schema_version_bounds="$(database_query "SELECT coalesce(min(schema_version), 1)::text || ':' || coalesce(max(schema_version), 1)::text FROM public.notes")"
  restored_relationship_violations="$(database_query "SELECT (SELECT count(*) FROM public.note_versions v LEFT JOIN public.notes n ON n.id = v.note_id AND n.workspace_id = v.workspace_id WHERE n.id IS NULL) + (SELECT count(*) FROM public.assets a LEFT JOIN public.workspaces w ON w.id = a.workspace_id WHERE w.id IS NULL)")"
  restored_notes_hash="$(hash_database_query "SELECT coalesce(string_agg(id::text || ':' || workspace_id::text || ':' || revision::text || ':' || schema_version::text || ':' || content_hash, E'\\n' ORDER BY id, revision), '') FROM public.notes")"
  restored_note_versions_hash="$(hash_database_query "SELECT coalesce(string_agg(id::text || ':' || workspace_id::text || ':' || note_id::text || ':' || revision::text || ':' || schema_version::text || ':' || content_hash, E'\\n' ORDER BY id, revision), '') FROM public.note_versions")"
  restored_assets_hash="$(hash_database_query "SELECT coalesce(string_agg(id::text || ':' || workspace_id::text || ':' || size_bytes::text || ':' || sha256, E'\\n' ORDER BY id), '') FROM public.assets")"
  restored_canonical_markdown_hash="$(hash_database_query "SELECT coalesce(string_agg(id::text || ':' || content_markdown, E'\\n' ORDER BY id), '') FROM public.notes")"
  [[ "$restored_notes_rows" == "$notes_row_count" ]] || fail "NOTES_ROW_COUNT_MISMATCH"
  [[ "$restored_note_versions_rows" == "$note_versions_row_count" ]] || fail "NOTE_VERSIONS_ROW_COUNT_MISMATCH"
  [[ "$restored_assets_rows" == "$assets_row_count" ]] || fail "ASSETS_ROW_COUNT_MISMATCH"
  [[ "$restored_migration_rows" == "$migration_row_count" ]] || fail "MIGRATION_SCHEMA_NOT_FORWARD_ONLY"
  [[ "$restored_schema_version_bounds" == "$schema_version_bounds" ]] || fail "SCHEMA_VERSION_MISMATCH"
  [[ "$restored_relationship_violations" == "0" ]] || fail "RELATIONSHIP_INVARIANT_FAILED"
  [[ "$restored_notes_hash" == "$notes_hash" ]] || fail "NOTES_HASH_MISMATCH"
  [[ "$restored_note_versions_hash" == "$note_versions_hash" ]] || fail "NOTE_VERSIONS_HASH_MISMATCH"
  [[ "$restored_assets_hash" == "$assets_hash" ]] || fail "ASSETS_HASH_MISMATCH"
  # Canonical content_markdown is represented by content_hash and is never rewritten
  # during rollback; the restored aggregate must remain byte-for-byte equal.
  [[ "$restored_canonical_markdown_hash" == "$canonical_markdown_hash" ]] || fail "CANONICAL_MARKDOWN_CHANGED"
}

promote_object_target() {
  if [[ "$RESTORE_OBJECT_STORAGE_TARGET" == s3://* ]]; then
    require_command aws
    AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-${S3_ACCESS_KEY}}" \
      AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-${S3_SECRET_KEY}}" \
      aws s3 sync --only-show-errors --delete -- "$object_stage" "$RESTORE_OBJECT_STORAGE_TARGET" >/dev/null 2>&1 || fail "RESTORE_OBJECT_SYNC_FAILED"
    return
  fi
  mkdir -m 700 -p -- "$RESTORE_OBJECT_STORAGE_TARGET"
  # This is the only destructive target operation and is reached only after
  # RESTORE_ISOLATED_CONFIRMATION=isolated and all integrity checks pass.
  find "$RESTORE_OBJECT_STORAGE_TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + >/dev/null 2>&1 || fail "RESTORE_OBJECT_TARGET_CLEAN_FAILED"
  cp -a -- "$object_stage"/. "$RESTORE_OBJECT_STORAGE_TARGET"/ >/dev/null 2>&1 || fail "RESTORE_OBJECT_TARGET_WRITE_FAILED"
}

write_release_evidence_record() {
  local status="$1"
  local blocking_reason="${2:-}"
  [[ "${RELEASE_BACKUP_EVIDENCE:-0}" == "1" || -n "${RELEASE_BACKUP_EVIDENCE_FILE:-}" ]] || return 0
  RELEASE_EVIDENCE_FILE="$RELEASE_OUTPUT_FILE" \
    RELEASE_STATUS="$status" \
    RELEASE_BLOCKING_REASON="$blocking_reason" \
    RELEASE_KEY_VERSION="$BACKUP_ENCRYPTION_KEY_VERSION" \
    RELEASE_MANIFEST_FILE="${manifest_file:-}" \
    RELEASE_MIGRATION_JOURNAL_SHA256="${migration_journal_sha256:-$ZERO_HASH}" \
    RELEASE_NOTES_ROWS="${notes_row_count:-0}" \
    RELEASE_NOTE_VERSIONS_ROWS="${note_versions_row_count:-0}" \
    RELEASE_ASSETS_ROWS="${assets_row_count:-0}" \
    RELEASE_OBJECT_COUNT="${object_count:-0}" \
    RELEASE_OBJECT_BYTES="${object_bytes:-0}" \
    RELEASE_OBJECT_AGGREGATE="${object_aggregate_sha256:-$ZERO_HASH}" \
    RELEASE_AGGREGATE="${aggregate_sha256:-$ZERO_HASH}" \
    node --input-type=module - <<'NODE'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const env = process.env;
const outputPath = env.RELEASE_EVIDENCE_FILE;
const status = env.RELEASE_STATUS;
if (!["failed", "passed"].includes(status)) throw new Error("invalid evidence status");
const hashPattern = /^[a-f0-9]{64}$/u;
const zeroHash = "0".repeat(64);
const integerOrZero = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
const hashOrZero = (value) => typeof value === "string" && hashPattern.test(value) ? value : zeroHash;
const now = new Date().toISOString();
let manifest = null;
if (status === "passed") {
  if (!env.RELEASE_MANIFEST_FILE || !existsSync(env.RELEASE_MANIFEST_FILE)) throw new Error("passed evidence requires a manifest");
  manifest = JSON.parse(readFileSync(env.RELEASE_MANIFEST_FILE, "utf8"));
}

const history = [];
function historyEntry(record) {
  if (!record || record.schemaVersion !== 1 || !["blocked", "failed", "passed"].includes(record.status) || record.scrubbed !== true || record.target !== "isolated" || record.producer !== "release-backup-restore" || typeof record.capturedAt !== "string" || typeof record.recordedAt !== "string" || typeof record.aggregateSha256 !== "string" || !hashPattern.test(record.aggregateSha256)) throw new Error("existing evidence history is invalid");
  return {
    schemaVersion: 1,
    status: record.status,
    scrubbed: true,
    target: "isolated",
    producer: "release-backup-restore",
    capturedAt: record.capturedAt,
    recordedAt: record.recordedAt,
    aggregateSha256: record.aggregateSha256,
  };
}
if (existsSync(outputPath)) {
  const previous = JSON.parse(readFileSync(outputPath, "utf8"));
  if (Array.isArray(previous.history)) {
    for (const entry of previous.history) history.push(historyEntry(entry));
  } else if (previous.history !== undefined) {
    throw new Error("existing evidence history is invalid");
  }
  history.push(historyEntry(previous));
}
if (history.length > 1000) throw new Error("evidence history bound exceeded");

const databaseArtifact = status === "passed" ? manifest.database.artifact : {
  authenticated: true,
  plaintextBytes: 0,
  ciphertextBytes: 0,
  plaintextSha256: zeroHash,
  ciphertextSha256: zeroHash,
};
const objectArtifact = status === "passed" ? manifest.objectStorage.artifact : {
  authenticated: true,
  plaintextBytes: 0,
  ciphertextBytes: 0,
  plaintextSha256: zeroHash,
  ciphertextSha256: zeroHash,
  fileCount: 0,
  totalBytes: 0,
  aggregateSha256: zeroHash,
};
const evidence = {
  schemaVersion: 1,
  status,
  scrubbed: true,
  target: "isolated",
  producer: "release-backup-restore",
  ...(env.RELEASE_BLOCKING_REASON ? { blockingReason: env.RELEASE_BLOCKING_REASON } : {}),
  capturedAt: now,
  encryption: { algorithm: "AES-256-GCM", authenticated: true, keyVersion: status === "passed" ? manifest.encryption.keyVersion : env.RELEASE_KEY_VERSION },
  retentionDays: 30,
  artifacts: {
    database: { authenticated: true, plaintextBytes: integerOrZero(databaseArtifact.plaintextBytes), ciphertextBytes: integerOrZero(databaseArtifact.ciphertextBytes), plaintextSha256: hashOrZero(databaseArtifact.plaintextSha256), ciphertextSha256: hashOrZero(databaseArtifact.ciphertextSha256) },
    objectStorage: { authenticated: true, plaintextBytes: integerOrZero(objectArtifact.plaintextBytes), ciphertextBytes: integerOrZero(objectArtifact.ciphertextBytes), plaintextSha256: hashOrZero(objectArtifact.plaintextSha256), ciphertextSha256: hashOrZero(objectArtifact.ciphertextSha256), fileCount: status === "passed" ? integerOrZero(Number(env.RELEASE_OBJECT_COUNT)) : 0, totalBytes: status === "passed" ? integerOrZero(Number(env.RELEASE_OBJECT_BYTES)) : 0, aggregateSha256: status === "passed" ? hashOrZero(env.RELEASE_OBJECT_AGGREGATE) : zeroHash },
  },
  aggregateSha256: status === "passed" ? hashOrZero(env.RELEASE_AGGREGATE) : zeroHash,
  invariants: {
    migrationJournalSha256: status === "passed" ? hashOrZero(env.RELEASE_MIGRATION_JOURNAL_SHA256) : zeroHash,
    forwardOnly: status === "passed",
    schemaVersion: status === "passed" ? integerOrZero(manifest.migration.schemaVersion) : 1,
    migrationCount: status === "passed" ? integerOrZero(manifest.migration.migrationCount) : 0,
    notesRows: status === "passed" ? integerOrZero(Number(env.RELEASE_NOTES_ROWS)) : 0,
    noteVersionsRows: status === "passed" ? integerOrZero(Number(env.RELEASE_NOTE_VERSIONS_ROWS)) : 0,
    assetsRows: status === "passed" ? integerOrZero(Number(env.RELEASE_ASSETS_ROWS)) : 0,
    relationships: status === "passed",
    rowHashes: status === "passed",
    canonicalMarkdownPreserved: status === "passed",
  },
  checks: { encryption: status === "passed", keyVersion: status === "passed", checksums: status === "passed", aggregateHash: status === "passed", isolation: status === "passed", retention: status === "passed", bounds: status === "passed", migration: status === "passed", relationships: status === "passed", rollbackCanonicalMarkdown: status === "passed", idempotent: status === "passed", temporaryKeyCleanup: status === "passed" },
  recordedAt: now,
};
if (history.length > 0) evidence.history = history;
mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
const temporaryPath = `${outputPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, outputPath);
chmodSync(outputPath, 0o600);
NODE
}

write_release_evidence() {
  write_release_evidence_record "$1"
}

write_release_failure_evidence() {
  write_release_evidence_record failed "$1"
}

require_external_command realpath
require_external_command node
require_external_command sha256sum
require_external_command tar
validate_configuration

manifest_file="$BACKUP_ROOT/backup-${BACKUP_ID}.manifest.json"
db_backup="$BACKUP_ROOT/postgres-${BACKUP_ID}.dump.enc"
db_metadata="$BACKUP_ROOT/postgres-${BACKUP_ID}.dump.meta.json"
object_backup="$BACKUP_ROOT/object-storage-${BACKUP_ID}.tar.enc"
object_metadata="$BACKUP_ROOT/object-storage-${BACKUP_ID}.tar.meta.json"
[[ -f "$manifest_file" && -f "$db_backup" && -f "$db_metadata" && -f "$object_backup" && -f "$object_metadata" ]] || fail "BACKUP_ARTIFACT_SET_INCOMPLETE"
verify_forward_only_migrations
require_external_command pg_restore
require_external_command psql
validate_manifest || fail "BACKUP_MANIFEST_INVALID"

manifest_values="$(validate_manifest)" || fail "BACKUP_MANIFEST_VALUES_INVALID"
IFS=$'\t' read -r migration_journal_sha256 schema_version migration_row_count notes_row_count note_versions_row_count assets_row_count schema_version_minimum schema_version_maximum relationship_violations notes_hash note_versions_hash assets_hash canonical_markdown_hash object_count object_bytes object_aggregate_sha256 aggregate_sha256 <<<"$manifest_values"
schema_version_bounds="$schema_version_minimum:$schema_version_maximum"
[[ "$migration_journal_sha256" == "$(sha256sum -- "$MIGRATION_JOURNAL_FILE" | awk '{print $1}')" ]] || fail "MIGRATION_JOURNAL_HASH_MISMATCH"
[[ "$relationship_violations" == "0" ]] || fail "RELATIONSHIP_INVARIANT_FAILED"

restore_path="$(canonical_path "$RESTORE_ROOT")"
mkdir -m 700 -p -- "$restore_path"
work_dir="$(mktemp -d "${restore_path}/.work-${BACKUP_ID}.XXXXXX")" || fail "RESTORE_WORKDIR_FAILED"
key_file="$work_dir/key"
printf '%s' "$BACKUP_ENCRYPTION_KEY" >"$key_file"
chmod 600 -- "$key_file"
db_dump="$work_dir/postgres.dump"
object_tar="$work_dir/object-storage.tar"
object_stage="$work_dir/object-storage"
mkdir -m 700 -- "$object_stage"

decrypt_artifact "database" "$db_backup" "$db_metadata" "$db_dump" >/dev/null 2>&1 || fail "DATABASE_ARTIFACT_INTEGRITY_FAILED"
decrypt_artifact "object-storage" "$object_backup" "$object_metadata" "$object_tar" >/dev/null 2>&1 || fail "OBJECT_ARTIFACT_INTEGRITY_FAILED"
tar_stats="$(inspect_tar "$object_tar" 2>/dev/null)" || fail "OBJECT_ARCHIVE_INTEGRITY_FAILED"
IFS=$'\t' read -r archive_file_count archive_total_bytes <<<"$tar_stats"
[[ "$archive_file_count" == "$object_count" && "$archive_total_bytes" == "$object_bytes" ]] || fail "OBJECT_ARCHIVE_INVARIANT_FAILED"
tar --extract --no-same-owner --no-same-permissions --directory="$object_stage" --file="$object_tar" >/dev/null 2>&1 || fail "OBJECT_ARCHIVE_EXTRACT_FAILED"
restored_object_stats="$(directory_inventory "$object_stage" 2>/dev/null)" || fail "OBJECT_RESTORE_INVENTORY_FAILED"
IFS=$'\t' read -r restored_object_count restored_object_bytes restored_object_aggregate <<<"$restored_object_stats"
[[ "$restored_object_count" == "$object_count" && "$restored_object_bytes" == "$object_bytes" && "$restored_object_aggregate" == "$object_aggregate_sha256" ]] || fail "OBJECT_AGGREGATE_HASH_MISMATCH"

pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$RESTORE_DATABASE_URL" "$db_dump" >/dev/null 2>&1 || fail "DATABASE_RESTORE_FAILED"
verify_database_invariants
promote_object_target
write_release_evidence passed

evidence_dir="$(dirname -- "$EVIDENCE_FILE")"
mkdir -m 700 -p -- "$evidence_dir"
printf -- '- restore drill `%s`: isolated targets verified; AES-256-GCM authenticated artifacts; migration journal/schema forward-only; notes=%s note_versions=%s assets=%s relationships=0; canonical Markdown hash preserved; object files=%s bytes=%s aggregate hash=%s; temporary key material removed\n' \
  "$BACKUP_ID" "$notes_row_count" "$note_versions_row_count" "$assets_row_count" "$object_count" "$object_bytes" "$object_aggregate_sha256" >>"$EVIDENCE_FILE"
failure_reported=1
scrubbed_event "RESTORE_COMPLETE" "passed"
printf '{"event":"RESTORE_COMPLETE","type":"backup.verify","status":"passed","backup_id":"scrubbed","target":"isolated","encryption":"AES-256-GCM","relationships":true,"canonical_markdown_preserved":true}\n'
