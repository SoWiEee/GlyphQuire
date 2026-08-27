# Phase 5 Task 4d — Worker Storage Teardown Report

## Outcome

Closed the Important worker lifecycle leak identified after `3650eed`.
`S3ObjectStorage` now exposes an idempotent typed `destroy()` seam that closes
its owned AWS `S3Client`; `InMemoryObjectStorage` provides the same safe no-op
method. Worker startup now owns storage cleanup and closes initialized storage
before PostgreSQL on both normal shutdown and partial initialization failure.

## Implementation

- Added required `destroy(): void` to `ObjectStoragePort`.
- Added an idempotent `S3ObjectStorage.destroy()` that delegates once to the
  AWS client's `destroy()` method.
- Added the no-op `InMemoryObjectStorage.destroy()` implementation.
- Added `WorkerFactories.closeStorage` and the default implementation that
  calls the storage port's typed destroy seam.
- Tracked storage separately from the database during startup. A single
  cleanup helper attempts storage first and database second, retaining the
  first cleanup error while still attempting both resources.
- `StartedWorker.close()` continues to wait for runtime shutdown and caches its
  result, so repeated close calls perform each resource teardown once.
- Startup failures retain the stable scrubbed
  `JOB_FAILED: worker dependency initialization failed` error and clean up
  storage/database once when search or dispatcher initialization fails.

## TDD evidence

The lifecycle and adapter tests were written before the implementation and
failed for the missing teardown behavior:

| RED check | Result |
| --- | --- |
| `pnpm --filter @glyphquire/worker test -- src/index.test.ts` | 4 new lifecycle assertions failed because storage cleanup was never called |
| `pnpm --filter @glyphquire/storage test -- src/storage.test.ts` | S3 and in-memory teardown tests failed because `destroy()` was absent |

After implementation:

| GREEN check | Result |
| --- | --- |
| `pnpm --filter @glyphquire/worker test -- src/index.test.ts` | 14/14 passed |
| `pnpm --filter @glyphquire/storage test -- src/storage.test.ts` | 10/10 passed |

## Verification

All commands ran from `/home/acane/Desktop/GlyphQuire` in the foreground.

| Command | Result |
| --- | --- |
| `TEST_DATABASE_URL=postgresql://glyphquire_app:glyphquire_app_dev@127.0.0.1:5432/glyphquire_dev pnpm --filter @glyphquire/worker test` | 94/94 passed, including PostgreSQL lifecycle lock release/reclaim and search-race integration tests |
| `pnpm --filter @glyphquire/storage test` | 10/10 passed |
| `pnpm build` | passed |
| `pnpm typecheck` | passed |
| `pnpm lint` | passed |
| `pnpm --filter @glyphquire/worker test:start` | passed; valid and invalid production-start smoke cases emitted the expected scrubbed startup event |
| `pnpm exec prettier --check apps/worker/src/index.ts apps/worker/src/index.test.ts packages/storage/src/port.ts packages/storage/src/s3.ts packages/storage/src/fake.ts packages/storage/src/storage.test.ts` | passed |
| `git diff --check` | passed |

`pnpm format:check` remains red only for eight pre-existing files outside this
change: three API asset files, two worker thumbnail files, two database/queue
integration fixtures, and `pnpm-lock.yaml`. No unrelated files were formatted.
`README.md` is unchanged.

## Commit

Commit message: `fix: close worker storage resources`
