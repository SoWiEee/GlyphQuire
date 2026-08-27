# Task 5b Import Execution Report

## Outcome

Implemented the bounded, transactional import side of Phase 5 without changing Task 5a schemas,
`ArchiveReader`, export code, README, or Playwright artifacts.

- `ImportService.start` validates actor/workspace/target/revision/idempotency inputs, rejects an
  oversized `Blob` before reading it, authorizes an owner/editor, fingerprints source bytes plus
  `noteId`/`baseRevision`, commits the server-owned staging row before object upload, and commits
  the pending transition plus typed `import` enqueue in one PostgreSQL transaction.
- `ImportService.getStatus` validates the import identifier and requires both the initiating actor
  and current workspace membership. Responses contain only bounded progress and sanitized error
  codes; the manifest never stores raw Markdown.
- The worker validates bounded Markdown/ZIP inputs, canonicalizes archive paths, rejects traversal,
  absolute paths, symlinks, encrypted/ZIP64/oversized archives and active-content extensions,
  parses/serializes through document-engine, and remaps imported asset references to logical
  `asset://` identifiers.
- Asset resource rows and the bounded manifest are committed before each external resource write.
  Retry resumes declared/uploaded resources idempotently. The single finalization transaction
  verifies ownership/live references/quota, performs the target-note CAS or note creation, creates
  asset metadata, promotes resources, enqueues search indexing, and marks the import completed.
- The cleanup handler enforces the 3600-second grace, exact workspace/import/resource key ownership,
  live-reference preservation, retryable compensation states, and bounded staging scans. Atomic
  claim predicates prevent an importer and compensator from owning the same row concurrently.
- Added only the spec-defined import polling seam, `GET /api/v1/imports/:id`; export endpoints remain
  untouched. Registered only `import` and `import.cleanup` in the worker registry.

## TDD Evidence

Initial RED failures were captured before implementation:

- ImportService integration: failed to resolve `./ImportService.js`.
- Worker recovery integration: failed to resolve `./import-cleanup.js`.
- Import status route: failed to resolve `./transfer.js`.
- Three added crash-state regressions failed on the old behavior: cleanup deleted an active
  processing import, an importer reclaimed a compensation-owned row, and expiration was overwritten
  as failure.
- Boundary validation regression exposed a raw PostgreSQL UUID parse error for an invalid `noteId`.

All of those cases are now GREEN. The ZIP regression additionally injects a crash after the external
resource put and proves the resource was declared first, remains retryable, is promoted exactly once,
and is rewritten to a logical asset reference only at finalization.

## Verification

- `pnpm --filter @glyphquire/api typecheck` — passed.
- `pnpm --filter @glyphquire/worker typecheck` — passed.
- `pnpm --filter @glyphquire/api build` — passed.
- `pnpm --filter @glyphquire/worker build` — passed.
- `pnpm --filter @glyphquire/api test` — 38 passed.
- API integration suite against isolated PostgreSQL `glyphquire_task5b_import` — 201 passed,
  22 skipped.
- Worker package suite against the isolated PostgreSQL database — 100 passed, including the final
  focused recovery suite at 6/6.
- Import route + ImportService focused integration — 5/5 passed.
- Worker registry focused suites — 39/39 passed.
- Targeted ESLint — passed with no findings.
- Targeted Prettier and `git diff --check` — passed.

The shared development database was not migrated or otherwise modified. A separately created,
fully migrated database was used because the shared database had pre-0008 migration drift. The
migration role was used for these tests because the newly created isolated database did not have the
normal runtime grants provisioned by the surrounding deployment workflow.

## Security Assumptions and Follow-up

- Authorization is checked when the import is started and again when status is read. The worker
  treats the durable, server-created import row plus exact typed job scope as its authority and does
  not re-evaluate membership at finalization. Product/security should confirm whether membership
  revocation is intended to cancel already-authorized queued imports.
- Quota is rechecked inside finalization, but the existing asset service and imports do not share a
  workspace-wide quota lock. A concurrent asset creation and import could theoretically race the
  aggregate check; a shared quota reservation/locking design is outside this bounded slice.
- Import tests use the real PostgreSQL schema and the in-memory object-storage adapter. A real-MinIO
  import crash/retry exercise remains desirable at the combined Task 5 integration boundary.
- The transfer route file contains only the import polling endpoint. The export owner must extend
  this seam without replacing it, and the later application-composition task must mount the combined
  transfer router.
