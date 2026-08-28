# Task 5b Import Race Remediation Report

## Outcome

Fixed the import/compensation ownership races without a schema migration and without changing
`ArchiveReader`, README, or Playwright artifacts.

- Each import now holds a PostgreSQL session advisory lock for its full handler invocation,
  including external object reads/writes, finalization, and failure compensation. A concurrent
  import attempt or cleanup fails retryably instead of overlapping the active owner.
- `imports.manifest._lifecycle` persists the owner kind, immutable job id, monotonic attempt, and
  lease expiry. A crashed `processing` owner is reclaimable only by a newer attempt for the same
  import job after the configured queue-lock lease expires.
- Import claim, manifest progress, post-put resource transition, finalization, and failure updates
  use owner/state predicates. A resource found `cleaned` after a put is deleted immediately; if
  that delete fails, its ledger is restored to `uploaded` so compensation remains able to find it.
  Either path re-requires compensation and the failed attempt remains retryable.
- Cleanup uses the same per-import lock plus a persisted cleanup owner. A `running` cleanup can be
  reclaimed only through an expired lease/new generation, every destructive transition checks
  current ownership, and cleanup failure cannot overwrite a terminal completed state.
- Successful import finalization and successful compensation remove the transient lifecycle owner
  from the public progress manifest.

## TDD Evidence

The initial real-PostgreSQL RED run had 6 passing existing cases and exactly 4 new failures:

1. a second import attempt resolved instead of being fenced while the first handler was paused;
2. a resource changed to `cleaned` after external put resolved without a guarded post-put failure;
3. a duplicate cleanup attempt resolved and entered deletion while the first cleanup was paused;
4. `recordCleanupFailure` replaced `completed/completed/null` with
   `failed/failed/JOB_FAILED`.

The same cases are now GREEN. An additional deterministic lease test proves a newer attempt is
rejected before expiry and reclaims the crashed `processing` owner exactly at expiry.

## Verification

- Focused real-PostgreSQL worker recovery:
  `TEST_DATABASE_URL=<isolated glyphquire_task5b_import> pnpm --filter @glyphquire/worker test -- src/handlers/import-recovery.integration.test.ts`
  — 11/11 passed.
- Full worker suite against the isolated PostgreSQL database — 9 files, 105/105 passed.
- API integration suite against the isolated PostgreSQL database — 20 files, 201 passed and 22
  existing conditional skips; the import service and route suites passed 5/5.
- `pnpm --filter @glyphquire/worker typecheck` — passed.
- `pnpm --filter @glyphquire/api typecheck` — passed.
- Targeted ESLint across all changed TypeScript files — passed.
- Targeted Prettier check and `git diff --check` — passed.

## Security Assumptions and Human Review

- All deployed import and cleanup workers must use this locking protocol. A rolling deployment must
  drain pre-fix workers before enabling the new workers; an old handler does not acquire the
  advisory lock and cannot participate safely in mixed-version execution.
- The PostgreSQL connection used by `Database.$client.reserve()` is session-bound until explicit
  release, and the application role must retain permission to call `pg_try_advisory_lock` and
  `pg_advisory_unlock`. A SHA-256-derived 64-bit advisory key collision only serializes unrelated
  imports; it does not permit concurrent ownership.
- PostgreSQL and object storage cannot form one atomic transaction. Resources remain predeclared
  before every put and cleanup is grace-delayed, but operators should retain bounded object-store
  request timeouts: a remote put that remains server-side in flight beyond process death and the
  full cleanup grace is outside the ordering guarantee available from the existing schema.
- Verification used the isolated database's migration role because that database does not include
  the deployment workflow's normal runtime grants. Production grant/readiness validation remains
  an integration/deployment review item.
