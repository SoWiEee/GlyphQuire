# Phase 5 Task 4d Ready-Dependency Fix Report

## Outcome

Fixed both Important lifecycle review findings on `f03ebba`.

1. Worker handlers are now created only after startup readiness and receive the
   exact initialized database, storage, search, and validated Phase 5
   environment instances. The old registry-level lazy client caches were
   removed, so the first claimed job cannot create a second database/storage
   client outside the lifecycle owner.
2. The document-engine and storage workspace packages now resolve source files
   under the `development` condition and compiled JavaScript under `import`/
   `default`. A valid-config built worker can import the static registry and
   reach its intentional P0 completeness gate without a loader error.

## Implementation

- `apps/worker/src/registry.ts` keeps the frozen five-key staged registry as a
  static fail-closed map. Its staged handlers return the stable `JOB_FAILED`
  initialization error until startup constructs a bound registry.
- `createJobRegistry(dependencies, baseRegistry)` constructs the reviewed
  PostgreSQL repositories and handlers from the ready instances. The optional
  base map preserves later static P0 handoffs while replacing only this slice's
  handler keys.
- `startWorker` imports and validates the static registry before dependency
  initialization, then builds and revalidates the bound registry after all
  readiness boundaries resolve. Custom injected registries retain their
  existing test/integration behavior.
- `apps/worker/src/index.test.ts` exercises a first dispatch through a registry
  built with a fake ready database/search port and asserts the handler reads
  that database and calls that search instance. The lifecycle close test also
  asserts that the initialized database instance is the one passed to the
  close hook.
- `apps/worker/scripts/production-start-smoke.sh` now runs both the existing
  invalid-config startup case and a valid-config built-worker case. The latter
  expects the static P0 startup failure event and rejects module-loader,
  internal-stack, URL, and storage-secret leakage.
- `apps/worker/src/production-start.test.ts` covers the production export
  shape for `@glyphquire/document-engine` and `@glyphquire/storage` alongside
  the existing queue/API-contract checks.

## TDD evidence

The new regression tests were run before implementation:

| RED check | Result |
| --- | --- |
| `pnpm --filter @glyphquire/worker test -- src/index.test.ts` | 10 passed, 1 failed: `createJobRegistry is not a function` |
| `pnpm --filter @glyphquire/worker test -- src/production-start.test.ts` | 2 existing export checks passed; 2 new checks failed because both packages exported `src/index.ts` |

After the corresponding implementation slices:

| GREEN check | Result |
| --- | --- |
| `pnpm --filter @glyphquire/worker test -- src/index.test.ts src/production-start.test.ts` | 15/15 passed |
| `pnpm --filter @glyphquire/worker typecheck` | passed |

## Final verification

All commands ran from `/home/acane/Desktop/GlyphQuire` in the foreground. No
services were started or detached.

| Command | Result |
| --- | --- |
| `TEST_DATABASE_URL=postgresql://glyphquire_app:glyphquire_app_dev@127.0.0.1:5432/glyphquire_dev pnpm --filter @glyphquire/worker test -- src/index.test.ts src/production-start.test.ts src/lifecycle.integration.test.ts` | 16/16 passed |
| `TEST_DATABASE_URL=postgresql://glyphquire_app:glyphquire_app_dev@127.0.0.1:5432/glyphquire_dev pnpm --filter @glyphquire/worker test` | 91/91 passed across 8 files |
| `pnpm --filter @glyphquire/worker test:start` | passed; invalid and valid-config built-worker smoke cases emitted one scrubbed startup event each |
| `pnpm build` | passed; all 15 runnable workspace projects built |
| `pnpm typecheck` | passed; all 15 runnable workspace projects typechecked |
| `pnpm lint` | passed |
| `pnpm exec prettier --check apps/worker/src/index.ts apps/worker/src/registry.ts apps/worker/src/index.test.ts apps/worker/src/production-start.test.ts packages/document-engine/package.json packages/storage/package.json` | passed |
| `git diff --check` | passed |
| `git diff -- README.md` | empty |

The repository-wide `pnpm format:check` remains red only for eight existing
files outside this fix's scope: three API asset files, two worker thumbnail
files, two database/queue integration fixtures, and `pnpm-lock.yaml`. No
unrelated files were reformatted.

## Commit

Commit message: `fix: bind worker registry to ready dependencies`
