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
