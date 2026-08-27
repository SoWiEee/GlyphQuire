#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/../../.." && pwd)
cd "$repository_root"

pnpm --filter '@glyphquire/worker...' build

set +e
output=$(
  env \
    NODE_ENV=production \
    DATABASE_URL=postgresql://worker:sentinel@localhost:5432/glyphquire \
    IDEMPOTENCY_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    BACKUP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    THUMBNAIL_MAX_PIXELS=40000001 \
    pnpm --filter @glyphquire/worker start 2>&1
)
status=$?
set -e

if [ "$status" -ne 1 ]; then
  printf '%s\n' "worker start smoke expected exit 1, received $status" >&2
  exit 1
fi

expected='{"event":"worker_startup_failed","code":"JOB_FAILED"}'
event_count=$(printf '%s\n' "$output" | grep -F -o "$expected" | wc -l | tr -d ' ')
if [ "$event_count" -ne 1 ]; then
  printf '%s\n' "worker start smoke did not emit exactly one scrubbed startup event" >&2
  exit 1
fi

if printf '%s\n' "$output" | grep -E -q \
  'ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|node:internal|postgresql://'; then
  printf '%s\n' "worker start smoke exposed loader or configuration details" >&2
  exit 1
fi

set +e
valid_output=$(
  env \
    NODE_ENV=production \
    DATABASE_URL=postgresql://worker:sentinel@localhost:5432/glyphquire \
    S3_ENDPOINT=http://localhost:9000 \
    S3_ACCESS_KEY=worker-access-key \
    S3_SECRET_KEY=worker-storage-secret \
    S3_BUCKET=glyphquire-assets \
    S3_REGION=us-east-1 \
    IDEMPOTENCY_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    BACKUP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    pnpm --filter @glyphquire/worker start 2>&1
)
valid_status=$?
set -e

if [ "$valid_status" -ne 1 ]; then
  printf '%s\n' "valid-config worker start smoke expected exit 1, received $valid_status" >&2
  exit 1
fi

valid_event_count=$(printf '%s\n' "$valid_output" | grep -F -o "$expected" | wc -l | tr -d ' ')
if [ "$valid_event_count" -ne 1 ]; then
  printf '%s\n' "valid-config worker start smoke did not emit exactly one scrubbed startup event" >&2
  exit 1
fi

if printf '%s\n' "$valid_output" | grep -E -q \
  'ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|node:internal|postgresql://|worker-storage-secret'; then
  printf '%s\n' "valid-config worker start smoke exposed loader or configuration details" >&2
  exit 1
fi
