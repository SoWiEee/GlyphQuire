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
