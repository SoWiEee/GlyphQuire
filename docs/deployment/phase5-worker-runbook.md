# Phase 5 worker runbook

## Preconditions

Run the role preflight and a verified backup before starting a worker. Workers
receive only `DATABASE_URL`; migration credentials and `MIGRATION_DATABASE_URL`
must remain in the migration job. Confirm PostgreSQL and MinIO health, then
verify the migration journal through `0000`–`0010` without editing journal
rows. The worker must be given a real `BackupVerifier` implementation that
derives `backups/<backupId>/manifest.json` and validates bounded relationship
and content-hash metadata. Startup intentionally fails closed when this seam
is absent.

## Start and observe

Build and start the worker with the repository's Node 22 toolchain:

```bash
pnpm --filter @glyphquire/worker build
pnpm --filter @glyphquire/worker start
```

For the optional local Compose profile, build or provide the worker image and
set `WORKER_DATABASE_URL`, S3 credentials, both encryption keys, and
`GLYPHQUIRE_WORKER_IMAGE` through a secret-aware environment file before
running `docker compose --profile phase5 up worker`. Compose waits for healthy
PostgreSQL and MinIO containers; it does not provide production credentials or
the backup verifier for you.

The runtime validates `JOB_*`, retention, cleanup, S3, and encryption settings
before opening a poll loop. It runs import-staging recovery every 15 minutes,
share/export/asset/idempotency scans hourly, and version retention daily.
Workspace/account purge jobs are re-enqueued until completion or the
30-day deadline. Inspect only structured job IDs, status, and stable error
codes; never log payloads, object keys, Markdown, or credentials.

## Recovery

Use the maintenance API to inspect and replay dead letters with a fresh,
bounded idempotency key. A `JOB_FAILED` result remains retryable and is not
silently acknowledged. Stop the worker before migrations or destructive
restores, run the pre-destructive backup hook, then restart only after the
database, storage, and verifier are ready. A deadline breach is a release-
blocking incident; preserve the coordinator and its audit evidence for repair.
