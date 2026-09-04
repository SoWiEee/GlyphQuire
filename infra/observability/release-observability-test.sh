#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly COMPOSE_FILE="$SCRIPT_DIR/docker-compose.release.yml"
readonly CAPTURE_PATH="${RELEASE_ALERT_EVIDENCE_HOST_PATH:-}"
readonly RUNTIME_REPOSITORY="${RELEASE_ALERT_RUNTIME_REPOSITORY:-}"
readonly RUNTIME_DIGEST="${RELEASE_ALERT_RUNTIME_DIGEST:-}"
readonly OPERATIONS_EVIDENCE="${OPERATIONS_ALERT_EVIDENCE_FILE:-}"
compose_started=0

skip_external() {
  printf 'SKIPPED_EXTERNAL: %s\n' "${1:-external observability evidence is unavailable}" >&2
  exit 2
}

fail() {
  printf 'RELEASE_OBSERVABILITY_FAILED:%s\n' "${1:-CHECK_FAILED}" >&2
  exit 1
}

cleanup() {
  if (( compose_started == 1 )); then
    docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

[[ -n "$CAPTURE_PATH" ]] || skip_external "RELEASE_ALERT_EVIDENCE_HOST_PATH_MISSING"
[[ "$RUNTIME_REPOSITORY" =~ ^[a-z0-9._-]+(:[0-9]+)?(/[a-z0-9._-]+)*$ ]] || skip_external "RELEASE_ALERT_RUNTIME_REPOSITORY_INVALID"
[[ "$RUNTIME_DIGEST" =~ ^[a-f0-9]{64}$ ]] || skip_external "RELEASE_ALERT_RUNTIME_DIGEST_MUST_BE_SHA256"
[[ -n "$OPERATIONS_EVIDENCE" && -f "$OPERATIONS_EVIDENCE" ]] || skip_external "OPERATIONS_ALERT_EVIDENCE_FILE_MISSING"
[[ -f "$COMPOSE_FILE" ]] || skip_external "COMPOSE_FILE_MISSING"
command -v docker >/dev/null 2>&1 || skip_external "DOCKER_MISSING"
docker compose version >/dev/null 2>&1 || skip_external "DOCKER_COMPOSE_MISSING"
[[ "$CAPTURE_PATH" = /* ]] || skip_external "RELEASE_ALERT_EVIDENCE_HOST_PATH_MUST_BE_ABSOLUTE"
[[ -f "$CAPTURE_PATH" ]] || skip_external "RELEASE_ALERT_EVIDENCE_HOST_PATH_MISSING"

compose_started=1
docker compose -f "$COMPOSE_FILE" up -d --no-build evaluator router receiver >/dev/null

for service in evaluator router receiver; do
  ready=0
  for _attempt in $(seq 1 60); do
    if docker compose -f "$COMPOSE_FILE" exec -T "$service" node -e "fetch('http://127.0.0.1:8080/ready').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  (( ready == 1 )) || fail "${service^^}_NOT_READY"
done

send_probe() {
  local value="$1"
  docker compose -f "$COMPOSE_FILE" exec -T evaluator node --input-type=module -e "fetch('http://127.0.0.1:8080/probe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ok:${value}})}).then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))" >/dev/null
}

# Three failures exercise the consecutive policy. Four alternating samples
# exercise the rolling 50% policy without placing document data on the wire.
send_probe false
send_probe false
send_probe false
send_probe true
send_probe true
send_probe true

capture_has_pair() {
  CAPTURE_PATH="$CAPTURE_PATH" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    try {
      const value = JSON.parse(readFileSync(process.env.CAPTURE_PATH, "utf8"));
      const events = Array.isArray(value?.events) ? value.events : [];
      const firing = events.filter((event) => event?.phase === "firing");
      const resolved = events.some((event) => event?.phase === "resolved" && firing.some((item) => item.alert === event.alert && item.correlationId === event.correlationId));
      const serialized = JSON.stringify(value);
      if (!resolved || /password|token|cookie|https?:|markdown|body|provider|secret/i.test(serialized)) process.exit(1);
    } catch { process.exit(1); }
  '
}

for _attempt in $(seq 1 30); do
  if [[ -s "$CAPTURE_PATH" ]] && capture_has_pair; then
    break
  fi
  sleep 1
done
[[ -s "$CAPTURE_PATH" ]] || fail "RECEIVER_CAPTURE_MISSING"
capture_has_pair || fail "RECEIVER_CAPTURE_MISSING_MATCHED_RECOVERY"

OPERATIONS_ALERT_EVIDENCE_FILE="$OPERATIONS_EVIDENCE" \
RELEASE_ALERT_EVIDENCE_FILE="$CAPTURE_PATH" \
  pnpm exec vitest run --config tests/integration/vitest.config.ts tests/integration/operations-alerting.test.ts tests/integration/release-observability.test.ts

printf 'RELEASE_OBSERVABILITY_PASSED:receiver_capture_validated\n'
