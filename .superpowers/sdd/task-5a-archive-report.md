# Phase 5 Task 5a Archive and Persistence Report

## Outcome

Phase 5 Task 5a is implemented on top of `f9a2798`. This bounded slice adds the
transfer persistence records, migration `0008_phase5_exports`, and a secure ZIP
reader with the exact production limits from the brief. Import/export services,
handlers, routes, and worker behavior remain intentionally unimplemented for a
later Task 5 slice.

## Security assumptions and decisions

- Transfer `actorId` and `requesterId` values remain opaque text identifiers
  tied to the existing user table. This slice adds database scope constraints;
  later services must still authenticate the actor and authorize current
  workspace/note access before using these records.
- Note-scoped import and export rows use composite note/workspace foreign keys.
  Import resources use a composite import/workspace foreign key plus an exact
  server-derived object-key check, preventing cross-import or cross-workspace
  staging-ledger ownership.
- Idempotency keys are unique within actor/requester and workspace scope. A
  lowercase SHA-256 request fingerprint is stored for later same-request replay
  verification. Manifest JSON is object-shaped and bounded to 1 MiB; persisted
  error text is bounded to 4,000 characters and is intended to contain only a
  caller-sanitized error.
- `ArchiveReader` validates both central-directory and local-header metadata
  before creating a private extraction directory. It rejects absolute paths,
  drive paths, parent traversal, canonical duplicates, file/descendant
  collisions, symlinks and other special Unix entries, encrypted/split/ZIP64
  inputs, unsupported compression, malformed/truncated archives, CRC/size
  mismatches, and every configured size/count overrun.
- Archive content is inflated entry-by-entry with runtime per-entry and
  aggregate counters in addition to declared-size checks. Writes use confined
  canonical paths, exclusive file creation with mode `0600`, and await all
  scheduled writes before failure cleanup. Any rejected archive is removed from
  its dedicated temporary directory.
- `temporaryRoot`, when injected, is a trusted server-controlled parent. The
  returned extraction handle must be cleaned by its caller after import
  processing. Production maxima cannot be raised through reader options.
- The reader deliberately preserves entry bytes without interpreting Markdown.
  The caller must pass Markdown through `@glyphquire/document-engine`; focused
  tests prove unsupported blocks retain source bytes and invalid custom syntax
  is rejected at that caller seam.

## Persistence and migration

- `imports`: UUID identity, opaque actor, workspace/optional target-note scope,
  required matching base revision for existing-note imports, exact derived
  source key, staging lifecycle, compensation lifecycle, expiry, scoped replay
  identity/fingerprint, bounded manifest, and bounded sanitized error.
- `import_resources`: strict import/workspace ownership, optional promoted asset
  identity, exact derived staging key, and
  `declared|uploaded|promoted|cleaned` state constraints.
- `exports`: requester/workspace and optional note scope, format and lifecycle,
  scoped replay identity/fingerprint, exact optional server artifact key,
  expiry, and bounded sanitized error.
- Migration coverage exercises a fresh database, exact `0007` upgrade, rerun
  without journal drift, forced transactional rollback, preservation of prior
  Markdown bytes, clean recovery after rollback, catalog constraints, cascade
  ownership, and split migration/runtime privileges.

Migration artifact SHA-256 evidence:

| Artifact | SHA-256 |
| --- | --- |
| `0008_phase5_exports.sql` | `9a6ad7ed95a5e65b0dc0e2daba5e3720c28e822752b32ff254565e754b42b14e` |
| `meta/0008_snapshot.json` | `ded0f2c864ad7531011f6df4fc3a07a708a72e429b0b0bbc866bceb8a2ce73ef` |

The Task 5 migration test freezes and rechecks the exact committed SHA-256
values for migrations `0000` through `0007`. A follow-up schema generation
reported `No schema changes, nothing to migrate`, confirming schema/snapshot
alignment.

## TDD evidence

- Archive RED:
  `pnpm --filter @glyphquire/api test -- src/modules/transfer/transfer-archive.test.ts`
  failed during module resolution because `ArchiveLimits` and `ArchiveReader`
  did not exist.
- Archive GREEN: the same command passes 16/16 tests covering regular
  extraction/cleanup, traversal and absolute paths, canonical collisions,
  symlinks, malformed inputs, all four limits, and the document-engine seam.
- Persistence RED: the real-PostgreSQL focused command initially passed 2 and
  failed 5 tests because the new exports, imports, resource ledger, migration,
  and constraints did not exist.
- Persistence GREEN: the focused real-PostgreSQL transfer suite passes 7/7.
  The complete database package passes 61 tests with one compose-only test
  intentionally skipped.

## Compatibility adjustment

Adding `0008` exposed two assertions in
`packages/database/src/migrations/phase5-search.integration.test.ts` that
treated `0007` as the permanent repository tail. With explicit orchestrator
authorization, only these compatibility assertions changed:

- Line 144 now inspects migration positions 6 and 7 rather than the last two
  entries, preserving the exact `0006` then `0007` assertion after `0008`.
- Lines 283-285 now compare the forced-rollback journal length with the index of
  `0007_phase5_search`, preserving the exact pre-`0007` state independently of
  later migrations.

No production behavior or frozen `0000`-`0007` migration bytes changed.

## Verification

| Gate | Result |
| --- | --- |
| Focused archive tests | 16 passed |
| Full API unit tests | 37 passed |
| Focused transfer PostgreSQL tests | 7 passed |
| Full database tests with real loopback PostgreSQL | 61 passed, 1 compose-only skip |
| `pnpm typecheck` | passed across all workspace packages |
| `pnpm lint` | passed |
| Focused Prettier check for all owned source/test files | passed |
| `git diff --check` | passed |
| Drizzle schema/snapshot regeneration check | no schema changes |

## Concern for integration review

The repository-wide `pnpm format:check` remains red on eight files that were
already committed in the base, including the pnpm-generated lockfile style and
seven Task 4 files outside this slice. The exact Task 5a source and test set
passes a focused Prettier check; no unrelated formatting churn was introduced.
