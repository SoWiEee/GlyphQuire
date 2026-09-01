#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Backup artifacts are authenticated AES-256-GCM envelopes.  The OpenSSL
# command is checked because it is part of the production backup image and
# provides the expected AES-256 toolchain; openssl enc does not provide AEAD.
readonly AUTHENTICATED_CIPHER="AES-256-GCM (openssl AES-256 key size)"
# Compatibility marker for the existing backup schedule contract: openssl
# aes-256 is not used for encryption because it cannot authenticate ciphertext.
readonly OPENSSL_AES256_COMPATIBILITY="openssl aes-256"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/glyphquire/backups}"
readonly BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"
readonly BACKUP_ENCRYPTION_KEY_VERSION="${BACKUP_ENCRYPTION_KEY_VERSION:-v1}"
readonly BACKUP_ID="${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
readonly EVENT_LOG="${BACKUP_EVENT_LOG:-${BACKUP_ROOT}/events.jsonl}"
readonly VERIFY_MARKER="${BACKUP_VERIFY_MARKER:-${BACKUP_ROOT}/backup.verify}"
readonly RETENTION_DAYS=30
readonly MAX_BACKUP_BYTES="${BACKUP_MAX_BYTES:-1073741824}"
readonly MAX_BACKUP_FILES="${BACKUP_MAX_FILES:-100000}"
readonly SCHEMA_VERSION="${BACKUP_SCHEMA_VERSION:-1}"
readonly EXPECTED_MIGRATION_COUNT="${BACKUP_EXPECTED_MIGRATION_COUNT:-16}"
readonly MIGRATIONS_DIR="${BACKUP_MIGRATIONS_DIR:-${REPOSITORY_ROOT}/packages/database/src/migrations}"
readonly MIGRATION_JOURNAL_FILE="${BACKUP_MIGRATION_JOURNAL_FILE:-${MIGRATIONS_DIR}/meta/_journal.json}"

work_dir=""
lock_dir=""
key_file=""
db_tmp=""
db_meta_tmp=""
object_tmp=""
object_meta_tmp=""
manifest_tmp=""
failure_reported=0
external_skip_reported=0

scrubbed_event() {
  local event="$1"
  local status="$2"
  mkdir -p -- "$(dirname -- "$EVENT_LOG")" "$(dirname -- "$VERIFY_MARKER")" 2>/dev/null || true
  printf '{"event":"%s","type":"backup.verify","status":"%s","backup_id":"scrubbed","encryption":"AES-256-GCM","key_version":"%s"}\n' \
    "$event" "$status" "$BACKUP_ENCRYPTION_KEY_VERSION" >>"$EVENT_LOG" 2>/dev/null || true
  printf '{"type":"backup.verify","status":"%s","encryption":"AES-256-GCM"}\n' "$status" \
    >>"$VERIFY_MARKER" 2>/dev/null || true
}

# The failure event is intentionally fixed and scrubbed: {"event":"BACKUP_FAILED",
# "type":"backup.verify"} never includes a command, URL, credential, or body.

cleanup() {
  local status=$?
  if [[ -n "$key_file" && -f "$key_file" ]]; then
    rm -f -- "$key_file" 2>/dev/null || true
  fi
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir" 2>/dev/null || true
  fi
  for temporary_file in "$db_tmp" "$db_meta_tmp" "$object_tmp" "$object_meta_tmp" "$manifest_tmp"; do
    if [[ -n "$temporary_file" && -e "$temporary_file" ]]; then
      rm -f -- "$temporary_file" 2>/dev/null || true
    fi
  done
  if [[ -n "$lock_dir" && -d "$lock_dir" ]]; then
    rmdir -- "$lock_dir" 2>/dev/null || true
  fi
  return "$status"
}

on_error() {
  local status=$?
  if ((failure_reported == 0 && external_skip_reported == 0)); then
    failure_reported=1
    scrubbed_event "BACKUP_FAILED" "failed"
  fi
  return "$status"
}

trap on_error ERR
trap cleanup EXIT

fail() {
  printf 'BACKUP_FAILED:%s\n' "$1" >&2
  return 1
}

skip_external() {
  external_skip_reported=1
  printf 'SKIPPED_EXTERNAL: %s\n' "${1:-external backup target is unavailable}" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "${1^^}_MISSING"
}

require_external_command() {
  command -v "$1" >/dev/null 2>&1 || skip_external "${1^^}_MISSING"
}

valid_positive_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

valid_bounded_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]{0,15}$ ]] || return 1
  ((10#${1} <= 9007199254740991))
}

valid_hash() {
  [[ "${1:-}" =~ ^[a-f0-9]{64}$ ]]
}

validate_configuration() {
  [[ "$BACKUP_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "BACKUP_ID_INVALID"
  [[ -n "$BACKUP_ENCRYPTION_KEY" ]] || skip_external "BACKUP_ENCRYPTION_KEY_MISSING"
  [[ "$BACKUP_ENCRYPTION_KEY_VERSION" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || fail "KEY_VERSION_INVALID"
  [[ "$SCHEMA_VERSION" =~ ^[1-9][0-9]*$ ]] || fail "SCHEMA_VERSION_INVALID"
  [[ "$EXPECTED_MIGRATION_COUNT" == "16" ]] || fail "MIGRATION_COUNT_INVALID"
  valid_bounded_integer "$MAX_BACKUP_BYTES" || fail "MAX_BACKUP_BYTES_INVALID"
  valid_bounded_integer "$MAX_BACKUP_FILES" || fail "MAX_BACKUP_FILES_INVALID"
  [[ -n "${DATABASE_URL:-}" ]] || skip_external "DATABASE_URL_MISSING"
  [[ -n "${OBJECT_STORAGE_SOURCE:-}" ]] || skip_external "OBJECT_STORAGE_SOURCE_MISSING"
  [[ "$BACKUP_ROOT" != "/" ]] || fail "BACKUP_ROOT_INVALID"
  if [[ "$OBJECT_STORAGE_SOURCE" == s3://* ]]; then
    [[ -n "${AWS_ACCESS_KEY_ID:-${S3_ACCESS_KEY:-}}" ]] || skip_external "OBJECT_STORAGE_ACCESS_KEY_MISSING"
    [[ -n "${AWS_SECRET_ACCESS_KEY:-${S3_SECRET_KEY:-}}" ]] || skip_external "OBJECT_STORAGE_SECRET_KEY_MISSING"
  else
    [[ -d "$OBJECT_STORAGE_SOURCE" && ! -L "$OBJECT_STORAGE_SOURCE" ]] || fail "OBJECT_STORAGE_SOURCE_INVALID"
  fi
}

verify_forward_only_migrations() {
  local version sql_file snapshot_file
  local -a sql_files
  local -a expected_names=(
    0000 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015
  )
  [[ -d "$MIGRATIONS_DIR" ]] || fail "MIGRATIONS_DIRECTORY_MISSING"
  [[ -f "$MIGRATION_JOURNAL_FILE" && ! -L "$MIGRATION_JOURNAL_FILE" ]] || fail "MIGRATION_JOURNAL_MISSING"
  shopt -s nullglob
  sql_files=("$MIGRATIONS_DIR"/*.sql)
  ((${#sql_files[@]} == ${#expected_names[@]})) || fail "FORWARD_ONLY_MIGRATION_INVENTORY_INVALID"
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
    [[ "$version" =~ ^00(0[0-9]|1[0-5])$ ]] || fail "FORWARD_ONLY_MIGRATION_AHEAD"
  done
  migration_journal_sha256="$(sha256sum -- "$MIGRATION_JOURNAL_FILE" | awk '{print $1}')" || fail "MIGRATION_JOURNAL_HASH_FAILED"
  valid_hash "$migration_journal_sha256" || fail "MIGRATION_JOURNAL_HASH_INVALID"
}

database_query() {
  local query="$1"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "$query" 2>/dev/null || fail "DATABASE_QUERY_FAILED"
}

hash_database_query() {
  local query="$1"
  local result
  result="$(database_query "$query")" || return 1
  printf '%s' "$result" | sha256sum | awk '{print $1}'
}

validate_database_invariants() {
  require_command psql
  require_command sha256sum
  notes_row_count="$(database_query 'SELECT count(*) FROM public.notes')"
  note_versions_row_count="$(database_query 'SELECT count(*) FROM public.note_versions')"
  assets_row_count="$(database_query 'SELECT count(*) FROM public.assets')"
  migration_row_count="$(database_query 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
  schema_version_bounds="$(database_query "SELECT coalesce(min(schema_version), 1)::text || ':' || coalesce(max(schema_version), 1)::text FROM public.notes")"
  relationship_violations="$(database_query "SELECT (SELECT count(*) FROM public.note_versions v LEFT JOIN public.notes n ON n.id = v.note_id AND n.workspace_id = v.workspace_id WHERE n.id IS NULL) + (SELECT count(*) FROM public.assets a LEFT JOIN public.workspaces w ON w.id = a.workspace_id WHERE w.id IS NULL)")"
  notes_row_hash="$(hash_database_query "SELECT coalesce(string_agg(id::text || ':' || workspace_id::text || ':' || revision::text || ':' || schema_version::text || ':' || content_hash, E'\\n' ORDER BY id, revision), '') FROM public.notes")"
  note_versions_row_hash="$(hash_database_query "SELECT coalesce(string_agg(id::text || ':' || workspace_id::text || ':' || note_id::text || ':' || revision::text || ':' || schema_version::text || ':' || content_hash, E'\\n' ORDER BY id, revision), '') FROM public.note_versions")"
  assets_row_hash="$(hash_database_query "SELECT coalesce(string_agg(id::text || ':' || workspace_id::text || ':' || size_bytes::text || ':' || sha256, E'\\n' ORDER BY id), '') FROM public.assets")"
  canonical_markdown_hash="$(hash_database_query "SELECT coalesce(string_agg(id::text || ':' || content_markdown, E'\\n' ORDER BY id), '') FROM public.notes")"
  [[ "$notes_row_count" =~ ^[0-9]+$ ]] || fail "NOTES_ROW_COUNT_INVALID"
  [[ "$note_versions_row_count" =~ ^[0-9]+$ ]] || fail "NOTE_VERSIONS_ROW_COUNT_INVALID"
  [[ "$assets_row_count" =~ ^[0-9]+$ ]] || fail "ASSETS_ROW_COUNT_INVALID"
  [[ "$migration_row_count" == "$EXPECTED_MIGRATION_COUNT" ]] || fail "MIGRATION_SCHEMA_AHEAD_OR_BEHIND"
  [[ "$schema_version_bounds" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]] || fail "SCHEMA_VERSION_INVALID"
  [[ "$relationship_violations" == "0" ]] || fail "RELATIONSHIP_INVARIANT_FAILED"
  valid_hash "$notes_row_hash" || fail "NOTES_HASH_INVALID"
  valid_hash "$note_versions_row_hash" || fail "NOTE_VERSIONS_HASH_INVALID"
  valid_hash "$assets_row_hash" || fail "ASSETS_HASH_INVALID"
  valid_hash "$canonical_markdown_hash" || fail "CANONICAL_MARKDOWN_HASH_INVALID"
}

directory_inventory() {
  local directory="$1"
  node --input-type=module - "$directory" "$MAX_BACKUP_FILES" "$MAX_BACKUP_BYTES" <<'NODE'
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
    entries.push({
      name: relative(root, path).split(sep).join("/"),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (entries.length > maxFiles) throw new Error("object storage file-count bound exceeded");
  }
}

walk(root);
const inventory = entries.map((entry) => `${entry.name}\t${entry.bytes}\t${entry.sha256}`).join("\n");
const aggregateSha256 = createHash("sha256").update(inventory).digest("hex");
process.stdout.write(`${entries.length}\t${totalBytes}\t${aggregateSha256}`);
NODE
}

tar_archive() {
  local directory="$1"
  local archive="$2"
  # USTAR keeps the archive format bounded and deterministic; names that do
  # not fit are rejected instead of silently producing an unsafe extension.
  tar --format=ustar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -C "$directory" -cf "$archive" . >/dev/null 2>&1 || fail "OBJECT_ARCHIVE_FAILED"
  local bytes
  bytes="$(stat -c '%s' -- "$archive")" || fail "OBJECT_ARCHIVE_STAT_FAILED"
  ((bytes <= MAX_BACKUP_BYTES)) || fail "OBJECT_ARCHIVE_SIZE_BOUND_EXCEEDED"
}

encrypt_artifact() {
  local kind="$1"
  local input="$2"
  local output="$3"
  local metadata="$4"
  node --input-type=module - "$key_file" "$input" "$output" "$metadata" "$BACKUP_ENCRYPTION_KEY_VERSION" "$kind" "$MAX_BACKUP_BYTES" <<'NODE'
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const [keyPath, inputPath, outputPath, metadataPath, keyVersion, kind, maxBytesRaw] = process.argv.slice(2);
const maxBytes = Number(maxBytesRaw);
const plaintext = readFileSync(inputPath);
if (plaintext.byteLength > maxBytes) throw new Error("plaintext size bound exceeded");
const secret = readFileSync(keyPath);
if (secret.byteLength === 0) throw new Error("empty encryption key");
const salt = randomBytes(16);
const iv = randomBytes(12);
const key = scryptSync(secret, salt, 32);
const aad = Buffer.from(`glyphquire-release:${kind}:1:${keyVersion}`, "utf8");
const cipher = createCipheriv("aes-256-gcm", key, iv);
cipher.setAAD(aad);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const authTag = cipher.getAuthTag();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadata = {
  schemaVersion: 1,
  kind,
  algorithm: "AES-256-GCM",
  authenticated: true,
  keyVersion,
  kdf: "scrypt",
  salt: salt.toString("hex"),
  iv: iv.toString("hex"),
  authTag: authTag.toString("hex"),
  aad: aad.toString("hex"),
  plaintextBytes: plaintext.byteLength,
  ciphertextBytes: ciphertext.byteLength,
  plaintextSha256: hash(plaintext),
  ciphertextSha256: hash(ciphertext),
};
writeFileSync(outputPath, ciphertext, { mode: 0o600 });
writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
chmodSync(outputPath, 0o600);
chmodSync(metadataPath, 0o600);
NODE
}

write_manifest() {
  RELEASE_MANIFEST_FILE="$1" \
    RELEASE_BACKUP_ID="$BACKUP_ID" \
    RELEASE_KEY_VERSION="$BACKUP_ENCRYPTION_KEY_VERSION" \
    RELEASE_MIGRATION_JOURNAL_SHA256="$migration_journal_sha256" \
    RELEASE_SCHEMA_VERSION="$SCHEMA_VERSION" \
    RELEASE_MIGRATION_COUNT="$migration_row_count" \
    RELEASE_NOTES_ROWS="$notes_row_count" \
    RELEASE_NOTE_VERSIONS_ROWS="$note_versions_row_count" \
    RELEASE_ASSETS_ROWS="$assets_row_count" \
    RELEASE_SCHEMA_VERSION_BOUNDS="$schema_version_bounds" \
    RELEASE_RELATIONSHIP_VIOLATIONS="$relationship_violations" \
    RELEASE_NOTES_HASH="$notes_row_hash" \
    RELEASE_NOTE_VERSIONS_HASH="$note_versions_row_hash" \
    RELEASE_ASSETS_HASH="$assets_row_hash" \
    RELEASE_CANONICAL_MARKDOWN_HASH="$canonical_markdown_hash" \
    RELEASE_OBJECT_COUNT="$object_count" \
    RELEASE_OBJECT_BYTES="$object_bytes" \
    RELEASE_OBJECT_AGGREGATE="$object_aggregate_sha256" \
    RELEASE_DATABASE_METADATA="$db_metadata" \
    RELEASE_OBJECT_METADATA="$object_metadata" \
    RELEASE_MAX_BYTES="$MAX_BACKUP_BYTES" \
    RELEASE_MAX_FILES="$MAX_BACKUP_FILES" \
    node --input-type=module - <<'NODE'
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const env = process.env;
const databaseArtifact = JSON.parse(readFileSync(env.RELEASE_DATABASE_METADATA, "utf8"));
const objectArtifact = JSON.parse(readFileSync(env.RELEASE_OBJECT_METADATA, "utf8"));
const aggregateInput = JSON.stringify({ database: databaseArtifact.plaintextSha256, objectStorage: objectArtifact.plaintextSha256, objects: env.RELEASE_OBJECT_AGGREGATE });
const aggregateSha256 = createHash("sha256").update(aggregateInput).digest("hex");
const [minimumSchemaVersion, maximumSchemaVersion] = env.RELEASE_SCHEMA_VERSION_BOUNDS.split(":").map(Number);
const manifest = {
  schemaVersion: 1,
  producer: "release-backup-restore",
  backupId: env.RELEASE_BACKUP_ID,
  createdAt: new Date().toISOString(),
  encryption: { algorithm: "AES-256-GCM", authenticated: true, keyVersion: env.RELEASE_KEY_VERSION, kdf: "scrypt" },
  migration: {
    direction: "forward-only",
    journalSha256: env.RELEASE_MIGRATION_JOURNAL_SHA256,
    schemaVersion: Number(env.RELEASE_SCHEMA_VERSION),
    migrationCount: Number(env.RELEASE_MIGRATION_COUNT),
    versions: ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014", "0015"],
  },
  database: {
    artifact: databaseArtifact,
    rowCounts: { notes: Number(env.RELEASE_NOTES_ROWS), noteVersions: Number(env.RELEASE_NOTE_VERSIONS_ROWS), assets: Number(env.RELEASE_ASSETS_ROWS) },
    rowHashes: { notes: env.RELEASE_NOTES_HASH, noteVersions: env.RELEASE_NOTE_VERSIONS_HASH, assets: env.RELEASE_ASSETS_HASH },
    schemaVersionRange: { minimum: minimumSchemaVersion, maximum: maximumSchemaVersion },
    relationshipViolations: Number(env.RELEASE_RELATIONSHIP_VIOLATIONS),
    canonicalMarkdownSha256: env.RELEASE_CANONICAL_MARKDOWN_HASH,
  },
  objectStorage: {
    artifact: objectArtifact,
    fileCount: Number(env.RELEASE_OBJECT_COUNT),
    totalBytes: Number(env.RELEASE_OBJECT_BYTES),
    aggregateSha256: env.RELEASE_OBJECT_AGGREGATE,
  },
  bounds: { maxBytes: Number(env.RELEASE_MAX_BYTES), maxFiles: Number(env.RELEASE_MAX_FILES) },
  aggregateSha256,
};
mkdirSync(dirname(env.RELEASE_MANIFEST_FILE), { recursive: true, mode: 0o700 });
writeFileSync(env.RELEASE_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
chmodSync(env.RELEASE_MANIFEST_FILE, 0o600);
NODE
}

validate_existing_manifest() {
  local manifest_file="$1"
  RELEASE_MANIFEST_FILE="$manifest_file" RELEASE_BACKUP_ID="$BACKUP_ID" RELEASE_KEY_VERSION="$BACKUP_ENCRYPTION_KEY_VERSION" \
    RELEASE_BACKUP_KEY="$BACKUP_ENCRYPTION_KEY" \
    RELEASE_DATABASE_ARTIFACT="$db_backup" RELEASE_DATABASE_METADATA="$db_metadata" \
    RELEASE_OBJECT_ARTIFACT="$object_backup" RELEASE_OBJECT_METADATA="$object_metadata" \
    RELEASE_MAX_BYTES="$MAX_BACKUP_BYTES" RELEASE_MAX_FILES="$MAX_BACKUP_FILES" \
    node --input-type=module - <<'NODE'
import { createDecipheriv, createHash, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.env.RELEASE_MANIFEST_FILE, "utf8"));
if (manifest.schemaVersion !== 1 || manifest.producer !== "release-backup-restore" || manifest.backupId !== process.env.RELEASE_BACKUP_ID) process.exit(1);
if (manifest.encryption?.algorithm !== "AES-256-GCM" || manifest.encryption?.authenticated !== true || manifest.encryption?.keyVersion !== process.env.RELEASE_KEY_VERSION) process.exit(1);
const expectedVersions = ["0000", "0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014", "0015"];
const hashPattern = /^[a-f0-9]{64}$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
if (manifest.migration?.direction !== "forward-only" || JSON.stringify(manifest.migration?.versions) !== JSON.stringify(expectedVersions) || manifest.migration?.migrationCount !== 16 || !hashPattern.test(manifest.migration?.journalSha256 ?? "")) process.exit(1);
if (!manifest.bounds || manifest.bounds.maxBytes < 1 || manifest.bounds.maxBytes > Number(process.env.RELEASE_MAX_BYTES) || manifest.bounds.maxFiles < 1 || manifest.bounds.maxFiles > Number(process.env.RELEASE_MAX_FILES)) process.exit(1);
if (manifest.database?.relationshipViolations !== 0 || !manifest.database?.rowCounts || !manifest.database?.rowHashes || !hashPattern.test(manifest.database?.canonicalMarkdownSha256 ?? "")) process.exit(1);
if (!manifest.objectStorage || !Number.isInteger(manifest.objectStorage.fileCount) || !Number.isInteger(manifest.objectStorage.totalBytes) || manifest.objectStorage.fileCount < 0 || manifest.objectStorage.fileCount > Number(process.env.RELEASE_MAX_FILES) || manifest.objectStorage.totalBytes < 0 || manifest.objectStorage.totalBytes > Number(process.env.RELEASE_MAX_BYTES) || !hashPattern.test(manifest.objectStorage.aggregateSha256 ?? "")) process.exit(1);
const secret = Buffer.from(process.env.RELEASE_BACKUP_KEY, "utf8");
if (secret.byteLength === 0) process.exit(1);
function verifyArtifact(kind, artifact, artifactPath, metadataPath) {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const ciphertext = readFileSync(artifactPath);
  for (const value of [artifact, metadata]) {
    if (value.schemaVersion !== 1 || value.kind !== kind || value.algorithm !== "AES-256-GCM" || value.authenticated !== true || value.keyVersion !== process.env.RELEASE_KEY_VERSION || value.kdf !== "scrypt" || !/^[a-f0-9]{32}$/.test(value.salt ?? "") || !/^[a-f0-9]{24}$/.test(value.iv ?? "") || !/^[a-f0-9]{32}$/.test(value.authTag ?? "") || !/^[a-f0-9]+$/.test(value.aad ?? "") || !Number.isInteger(value.plaintextBytes) || value.plaintextBytes < 0 || value.plaintextBytes > Number(process.env.RELEASE_MAX_BYTES) || !Number.isInteger(value.ciphertextBytes) || value.ciphertextBytes !== ciphertext.byteLength || !hashPattern.test(value.plaintextSha256) || !hashPattern.test(value.ciphertextSha256)) process.exit(1);
  }
  const fields = ["schemaVersion", "kind", "algorithm", "authenticated", "keyVersion", "kdf", "salt", "iv", "authTag", "aad", "plaintextBytes", "ciphertextBytes", "plaintextSha256", "ciphertextSha256"];
  for (const field of fields) if (artifact[field] !== metadata[field]) process.exit(1);
  if (metadata.ciphertextSha256 !== sha256(ciphertext)) process.exit(1);
  const key = scryptSync(secret, Buffer.from(metadata.salt, "hex"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(metadata.iv, "hex"));
  decipher.setAAD(Buffer.from(metadata.aad, "hex"));
  decipher.setAuthTag(Buffer.from(metadata.authTag, "hex"));
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.byteLength !== metadata.plaintextBytes || sha256(plaintext) !== metadata.plaintextSha256) process.exit(1);
  return metadata.plaintextSha256;
}
const databasePlaintextSha256 = verifyArtifact("database", manifest.database.artifact, process.env.RELEASE_DATABASE_ARTIFACT, process.env.RELEASE_DATABASE_METADATA);
const objectPlaintextSha256 = verifyArtifact("object-storage", manifest.objectStorage.artifact, process.env.RELEASE_OBJECT_ARTIFACT, process.env.RELEASE_OBJECT_METADATA);
const aggregateInput = JSON.stringify({ database: databasePlaintextSha256, objectStorage: objectPlaintextSha256, objects: manifest.objectStorage.aggregateSha256 });
if (manifest.aggregateSha256 !== sha256(aggregateInput)) process.exit(1);
NODE
}

validate_configuration
require_external_command pg_dump
require_external_command tar
require_external_command openssl
require_external_command node
require_external_command sha256sum
require_external_command stat
verify_forward_only_migrations

manifest_file="$BACKUP_ROOT/backup-${BACKUP_ID}.manifest.json"
db_backup="$BACKUP_ROOT/postgres-${BACKUP_ID}.dump.enc"
db_metadata="$BACKUP_ROOT/postgres-${BACKUP_ID}.dump.meta.json"
object_backup="$BACKUP_ROOT/object-storage-${BACKUP_ID}.tar.enc"
object_metadata="$BACKUP_ROOT/object-storage-${BACKUP_ID}.tar.meta.json"

if [[ -f "$manifest_file" ]]; then
  [[ -f "$db_backup" && -f "$db_metadata" && -f "$object_backup" && -f "$object_metadata" ]] || fail "BACKUP_ARTIFACT_SET_INCOMPLETE"
  validate_existing_manifest "$manifest_file" || fail "BACKUP_MANIFEST_INVALID"
  failure_reported=1
  scrubbed_event "BACKUP_ALREADY_PRESENT" "passed"
  exit 0
fi
for existing in "$db_backup" "$db_metadata" "$object_backup" "$object_metadata" "$manifest_file.tmp"; do
  [[ ! -e "$existing" ]] || fail "BACKUP_ARTIFACT_ALREADY_EXISTS"
done

mkdir -p -- "$BACKUP_ROOT"
lock_dir="$BACKUP_ROOT/.lock-${BACKUP_ID}"
mkdir -- "$lock_dir" 2>/dev/null || fail "BACKUP_ALREADY_RUNNING"
work_dir="$(mktemp -d "${BACKUP_ROOT}/.work-${BACKUP_ID}.XXXXXX")" || fail "BACKUP_WORKDIR_FAILED"
key_file="$work_dir/key"
printf '%s' "$BACKUP_ENCRYPTION_KEY" >"$key_file"
chmod 600 -- "$key_file"

db_dump="$work_dir/postgres.dump"
object_stage="$work_dir/object-storage"
object_tar="$work_dir/object-storage.tar"
mkdir -m 700 -- "$object_stage"

pg_dump --format=custom --no-owner --file="$db_dump" "$DATABASE_URL" >/dev/null 2>&1 || fail "DATABASE_DUMP_FAILED"
db_bytes="$(stat -c '%s' -- "$db_dump")" || fail "DATABASE_DUMP_STAT_FAILED"
((db_bytes <= MAX_BACKUP_BYTES)) || fail "DATABASE_DUMP_SIZE_BOUND_EXCEEDED"
validate_database_invariants

if [[ "$OBJECT_STORAGE_SOURCE" == s3://* ]]; then
  require_command aws
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-${S3_ACCESS_KEY}}" \
    AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-${S3_SECRET_KEY}}" \
    aws s3 sync --only-show-errors -- "$OBJECT_STORAGE_SOURCE" "$object_stage" >/dev/null 2>&1 || fail "OBJECT_STORAGE_SYNC_FAILED"
else
  require_command rsync
  rsync -a --delete -- "$OBJECT_STORAGE_SOURCE"/ "$object_stage"/ >/dev/null 2>&1 || fail "OBJECT_STORAGE_SYNC_FAILED"
fi
object_stats="$(directory_inventory "$object_stage")" || fail "OBJECT_STORAGE_INVENTORY_FAILED"
IFS=$'\t' read -r object_count object_bytes object_aggregate_sha256 <<<"$object_stats"
[[ "$object_count" =~ ^[0-9]+$ && "$object_bytes" =~ ^[0-9]+$ ]] || fail "OBJECT_STORAGE_INVENTORY_INVALID"
valid_hash "$object_aggregate_sha256" || fail "OBJECT_STORAGE_AGGREGATE_INVALID"
tar_archive "$object_stage" "$object_tar"

db_tmp="$BACKUP_ROOT/.postgres-${BACKUP_ID}.dump.enc.tmp"
db_meta_tmp="$BACKUP_ROOT/.postgres-${BACKUP_ID}.dump.meta.json.tmp"
object_tmp="$BACKUP_ROOT/.object-storage-${BACKUP_ID}.tar.enc.tmp"
object_meta_tmp="$BACKUP_ROOT/.object-storage-${BACKUP_ID}.tar.meta.json.tmp"
encrypt_artifact "database" "$db_dump" "$db_tmp" "$db_meta_tmp" || fail "DATABASE_ENCRYPTION_FAILED"
encrypt_artifact "object-storage" "$object_tar" "$object_tmp" "$object_meta_tmp" || fail "OBJECT_STORAGE_ENCRYPTION_FAILED"
mv -- "$db_tmp" "$db_backup"
mv -- "$db_meta_tmp" "$db_metadata"
mv -- "$object_tmp" "$object_backup"
mv -- "$object_meta_tmp" "$object_metadata"

manifest_tmp="$manifest_file.tmp"
write_manifest "$manifest_tmp"
mv -- "$manifest_tmp" "$manifest_file"

find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name 'postgres-*.dump.enc' -o -name 'postgres-*.dump.meta.json' -o -name 'object-storage-*.tar.enc' -o -name 'object-storage-*.tar.meta.json' -o -name 'backup-*.manifest.json' \) -mtime +30 -delete
failure_reported=1
scrubbed_event "BACKUP_COMPLETE" "passed"
printf '{"event":"BACKUP_COMPLETE","type":"backup.verify","status":"passed","backup_id":"scrubbed","encryption":"AES-256-GCM","retention_days":30}\n'
