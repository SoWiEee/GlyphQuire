# Phase 5 alert-delivery evidence

`tests/integration/phase5-alerting.test.ts` validates a strict, bounded,
sanitized capture for backup failure, dead-letter, or queue-age notification.
It rejects delivery beyond 300 seconds, non-2xx delivery, expanded payloads,
secret-like fields, malformed timestamps, and captures above 16 KiB.

To supply real evidence, trigger the staging condition, export only the strict
sanitized JSON shape described by the test, and run:

```sh
PHASE5_ALERT_EVIDENCE_FILE=/secure/path/sanitized-alert.json \
  pnpm test:alerting:phase5
```

Execution on 2026-08-30: the deterministic validator passed 2 tests; the one
external evidence test was skipped because no actual operator-channel delivery
or recovery timestamp was supplied. The external case is intentionally skipped
without `PHASE5_ALERT_EVIDENCE_FILE`.
**Notification delivery within five minutes remains a release blocker.**

Never record the webhook URL, channel token, session cookie, provider response,
document content, archive name, or job payload in this file.

## Phase 6 evaluator/router/receiver rehearsal

Phase 6 keeps the same five-minute delivery boundary and adds the production
policy checks: 30-second probes with a five-second timeout, three consecutive
failures or a 50-percent rolling five-minute failure ratio, immediate backup,
dead-letter, and oldest-queue notifications, 80/90-percent capacity levels,
and three consecutive successes for recovery.

Run the configured operator-channel rehearsal with an existing absolute capture
file. The command fails closed when the Phase 5 capture or the Phase 6 host
capture is absent:

```sh
PHASE5_ALERT_EVIDENCE_FILE=/secure/path/phase5-alert.json \
PHASE6_ALERT_EVIDENCE_HOST_PATH=/secure/path/phase6-alert.json \
PHASE6_ALERT_EVIDENCE_FILE=/secure/path/phase6-alert.json \
PHASE6_ALERT_RUNTIME_REPOSITORY=registry.example/phase6-alert \
PHASE6_ALERT_RUNTIME_DIGEST=<64-hex> \
  pnpm test:integration:phase6-observability
```

`PHASE6_ALERT_RUNTIME_REPOSITORY` must contain only the image repository (no
tag), and `PHASE6_ALERT_RUNTIME_DIGEST` must be the lowercase immutable digest
produced from
`infra/observability/phase6-alert-runtime.Dockerfile`; the rehearsal does not
mount source files into the evaluator, router, or receiver containers.

The evaluator, router, and receiver exchange only the strict sanitized event
shape in `docs/evidence/phase6/alert-evidence.schema.json`. The receiver writes
firing and recovery timestamps and a successful delivery status; it never
records URLs, credentials, cookies, bodies, or provider diagnostics.
