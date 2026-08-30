# Phase 5 release runbook

Phase 5 is releasable only when every P0 row in `docs/evidence/phase5/README.md` is
green. A missing database, object store, browser, screen reader, load host, or
operator-channel capture is a release blocker; it is not an implicit pass.

## Preconditions

- Use Node 22 and the locked pnpm version. Run a frozen offline install from the
  release artifact.
- Provision a migrated PostgreSQL database, private S3/MinIO bucket, API,
  worker, and web origin. Keep session cookies, storage credentials, encryption
  keys, and alert webhook URLs in the deployment secret store.
- Configure the complete Phase 5 environment group. `apps/api/src/env.ts`
  rejects partial groups, non-HTTPS public alert URLs, credentials in URLs, and
  alert delivery bounds above 300 seconds.
- Seed five isolated personal workspaces and one configured operator for load
  and diagnostic evidence. Never paste cookies or document bodies into an
  evidence file or command transcript.

## Automated gates

Run from the repository root:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm -r test
pnpm test:cross-package
pnpm test:integration
CI=1 pnpm test:e2e
pnpm exec playwright test tests/e2e/phase5-accessibility.spec.ts --project=e2e
pnpm --filter @glyphquire/api exec vitest run --config vitest.integration.config.ts src/search-freshness.integration.test.ts
pnpm test:load:phase5 -- --duration=30m --users=5
pnpm test:alerting:phase5
git diff --check
```

The freshness command requires `TEST_DATABASE_URL`. The load command requires
`PHASE5_LOAD_BASE_URL`, five strict entries in `PHASE5_LOAD_ACTORS_JSON`, and
`PHASE5_LOAD_OPERATOR_COOKIE`. The alert command requires an actual sanitized
capture path in `PHASE5_ALERT_EVIDENCE_FILE`; without it, the external evidence
case is visibly skipped and the release remains blocked.

Run fresh, upgrade-from-`0004_phase3_themes`, and rerun migration suites against
disposable databases. Record migration file hashes and image digests, not
credentials or database contents.

## Manual evidence

Record the latest two stable Chrome, Firefox, Safari, and Edge results supplied
by release CI or manual testing. Complete one core flow with VoiceOver or NVDA.
Exercise upload through anonymous-share revocation, keyboard-only operation,
permission denial, retry, stale-index recovery, ZIP traversal rejection, and a
scrubbed-log review. Update the evidence files with timestamps and immutable CI
or artifact references.

## Deploy and verify

1. Take and verify the encrypted pre-deploy backup.
2. Apply expand-compatible migrations, then deploy API, worker, and web by
   immutable image digest.
3. Verify health/readiness, queue age, dead-letter count, storage access, and a
   root-relative browser API call. Do not expose storage credentials to web.
4. Trigger a sanitized test alert and verify operator-channel delivery within
   five minutes, then verify the recovery notification.
5. Observe error rate, queue age, and storage/database capacity before manual
   approval.

## Rollback and recovery

- Stop new traffic if readiness fails. Roll back application images to the last
  compatible digests; do not reverse an expand migration until compatibility
  and backup restore have been reviewed.
- For a dead letter, inspect only scrubbed codes and correlation IDs, correct
  the cause, then use the bounded operator replay endpoint. Never edit job
  payloads in place.
- For search lag, drain current jobs and run the bounded one-note rebuild. A
  cross-workspace result or freshness above 60 seconds blocks release.
- For data loss or destructive migration failure, follow the checked-in restore
  drill, verify note/version/asset hashes and relationships, and retain the
  append-only drill record.
