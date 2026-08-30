# Phase 5 lifecycle runbook

## Deletion workflow

Deletion requests require current owner membership (workspace) or an
authenticated account, the exact `DELETE_WORKSPACE` confirmation, and a
validated `Idempotency-Key`. The API records the coordinator and delayed job
atomically. The minimum delay is 24 hours; the 30-day deadline is measured from
confirmation. Do not delete rows or objects manually while a coordinator is
active.

`workspace.purge` rechecks the owner, grace, live references, and backup gate
inside its transaction. It removes dependent rows and server-derived object
keys while retaining its own lifecycle job until acknowledgement. Account
purge waits for every workspace coordinator, also supports zero-workspace
accounts, and retains a nullable-scope coordinator so retries remain possible
after foreign-key nulling. Failed object deletion stays visible as
`JOB_FAILED` and is re-enqueued by maintenance scans.

## Backup, restore, and rollback

Run `infra/backup/phase5-pre-destructive-hook.sh` before migrations or purge
operations. Daily backups are encrypted with `BACKUP_ENCRYPTION_KEY` and
retained for 30 days by `phase5-backup.sh`; failures emit only the scrubbed
`BACKUP_FAILED` event and exit non-zero. Use `phase5-restore-drill.sh` with an
isolated `RESTORE_DATABASE_URL` and object target. The drill verifies
note/revision/asset relationships and aggregate object hashes, then appends
evidence without document bodies or secrets.

For an incident, stop API and worker writes, preserve the failed database and
coordinator records, and restore only from a verified backup. Re-run baseline,
journal/hash, and role preflight checks before redeploying. Never rewrite a
migration journal or reuse development credentials in production.
