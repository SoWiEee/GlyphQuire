#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly COMPOSE_FILE="$SCRIPT_DIR/docker-compose.phase6.yml"
readonly CAPTURE_PATH="${PHASE6_ALERT_EVIDENCE_HOST_PATH:-}"
readonly RUNTIME_IMAGE="${PHASE6_ALERT_RUNTIME_IMAGE:-}"
readonly PHASE5_EVIDENCE="${PHASE5_ALERT_EVIDENCE_FILE:-}"
readonly PHASE6_EVIDENCE="${PHASE6_ALERT_EVIDENCE_FILE:-$REPOSITORY_ROOT/docs/evidence/phase6/alert-evidence.json}"
compose_started=0

fail() {
  printf 'PHASE6_OBSERVABILITY_BLOCKED:%s\n' "${1:-CHECK_FAILED}" >&2
  exit 2
}

cleanup() {
  if (( compose_started == 1 )); then
    docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

[[ -n "$CAPTURE_PATH" ]] || fail "PHASE6_ALERT_EVIDENCE_HOST_PATH_MISSING"
[[ "$RUNTIME_IMAGE" =~ ^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || fail "PHASE6_ALERT_RUNTIME_IMAGE_MUST_USE_IMMUTABLE_DIGEST"
[[ -n "$PHASE5_EVIDENCE" && -f "$PHASE5_EVIDENCE" ]] || fail "PHASE5_ALERT_EVIDENCE_FILE_MISSING"
[[ -f "$COMPOSE_FILE" ]] || fail "COMPOSE_FILE_MISSING"
command -v docker >/dev/null 2>&1 || fail "DOCKER_MISSING"
docker compose version >/dev/null 2>&1 || fail "DOCKER_COMPOSE_MISSING"
[[ "$CAPTURE_PATH" = /* ]] || fail "PHASE6_ALERT_EVIDENCE_HOST_PATH_MUST_BE_ABSOLUTE"
[[ -f "$CAPTURE_PATH" ]] || fail "PHASE6_ALERT_EVIDENCE_HOST_PATH_MISSING"

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
send_probe false
send_probe true
send_probe false

for _attempt in $(seq 1 30); do
  if [[ -s "$CAPTURE_PATH" ]]; then
    break
  fi
  sleep 1
done
[[ -s "$CAPTURE_PATH" ]] || fail "RECEIVER_CAPTURE_MISSING"

PHASE5_ALERT_EVIDENCE_FILE="$PHASE5_EVIDENCE" \
PHASE6_ALERT_EVIDENCE_FILE="$PHASE6_EVIDENCE" \
  pnpm exec vitest run --config /dev/null tests/integration/phase5-alerting.test.ts tests/integration/phase6-observability.test.ts

printf 'PHASE6_OBSERVABILITY_PASSED:receiver_capture_validated\n'
