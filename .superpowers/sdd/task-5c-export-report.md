# Task 5c — Durable Export Slice Report

## Outcome

Implemented the export-only Task 5c slice without changing Task 5b import lifecycle code or
`ArchiveReader`:

- `ExportService` authorizes server-resolved workspace/note scope, creates the pending export and
  typed `export` job in one PostgreSQL transaction, binds replay to requester/scope/format, and
  derives the artifact key from workspace/export ids.
- Status and download require both the original requester and current workspace membership.
  Status is contract-bounded and never returns `last_error`, content, or object keys. Download is
  available only for a completed, unexpired row and signs only the server-derived stored key.
- The worker handles note and workspace scopes plus Markdown, ZIP, and HTML. It reads canonical
  persisted Markdown without reserialization, discovers semantic `asset://` references through the
  document engine, verifies asset scope/key/size/SHA-256, and bounds source/file/artifact sizes.
- Note Markdown and every Markdown entry in ZIP are byte-exact. ZIP names are derived only from
  UUIDs (`notes/<id>.md`, `assets/<id>/original`) and include bounded `metadata.json`.
- HTML is rendered from the document-engine AST through a fixed inert element allowlist. User text,
  raw HTML, titles, and metadata are escaped; no user URL becomes `href`/`src`; a restrictive CSP is
  embedded; asset bytes are represented as inert base64 text.
- Artifact upload precedes the guarded `completed` transition. Failed completion remains retryable
  at the same deterministic key; completed/expired rows cannot be moved back to processing.
- Worker registry adds only `export`. `export.expire` remains intentionally absent for the later
  maintenance handoff.

## TDD Evidence

Focused RED failures were observed before each production seam:

- Missing `ExportService.ts` module.
- Missing `getStatus`/`getDownload` methods.
- Pending status remaining pending at the exact expiry cutoff.
- Export routes returning 404 before being mounted.
- Download query accepting a client `objectKey` before strict query rejection.
- Missing worker `export.ts` module.
- ZIP and HTML formats returning `JOB_FAILED` before their implementations.
- Workspace code-fence text being over-counted as an asset reference before semantic AST discovery.
- Registry missing the static `export` key.
- HTML source not yet rendered into semantic inert elements.

Final focused results after formatting:

- API transfer service/routes: 3 files, 8 tests passed (includes preserved import GET).
- Worker transfer/registry: 2 files, 38 tests passed.
- Real MinIO bucket-policy boundary: 2 tests passed.
- Cross-package conformance: 2 files, 58 tests passed.
- Root `pnpm typecheck`: passed.
- Root `pnpm lint`: passed.
- Root `pnpm build`: passed.
- Touched-file Prettier check and `git diff --check`: passed.

The live PostgreSQL tests used an isolated database migrated fresh through `0008`; the shared dev
database was not modified because its migration-baseline journal was stale.

## Security Assumptions and Decisions

- Existing note and asset read policy grants every current workspace member read access, so export
  start accepts every current member role. Export-record ownership is stricter: only the requester
  may poll or obtain a download URL, and membership is rechecked each time.
- PostgreSQL migration `0008` is trusted to enforce the scope shape, same-workspace note foreign key,
  request hash, and exact export object-key invariant. The service and worker repeat the key/scope
  checks as defense in depth.
- Presigned URLs are intentionally short-lived (five minutes by default) and cannot outlive the
  export row's remaining expiry.
- Default export retention is 30 days, matching the Phase 5 environment contract. Synchronous
  status/download checks mark due rows expired; physical object removal and `export.expire`
  scheduling remain owned by the later maintenance slice.
- Multi-note workspace Markdown is deterministic concatenation separated by two newline bytes;
  ZIP remains the lossless multi-file export because each Markdown entry is byte-exact and carries
  metadata/assets.

## Human Security Review

- Review the conservative HTML element mapping when new document-engine node types are introduced.
  Unknown/invalid source is escaped and URLs are never emitted today; future renderer expansion must
  preserve that default-deny rule.
- Confirm the product decision that current viewers may export readable workspace content. If export
  should instead be owner/editor-only, tighten `resolveScope` and add the corresponding denial case.
- `export.expire` scheduling and object deletion are deliberately not implemented in this slice;
  they remain a release dependency of the maintenance task.

## Post-review Remediation

The fresh verifier found an Important stale-attempt race: a reclaimed worker could overwrite the
canonical artifact after a newer attempt completed. The handler now records a bounded processing
owner token, uploads each attempt to a private candidate key, and performs a row-locked owner
recheck before canonical publication and completion. Superseded attempts cannot publish or mark the
row failed; their candidate object is deleted on normal exit. The deterministic PostgreSQL race
regression went RED before the fix and GREEN afterward (export integration 7/7, worker full suite
89 passed/40 skipped, root typecheck/lint/build/test and cross-package 58/58 passed).

Operational assumptions: workers must be drained during rollout so pre-fix binaries cannot publish
unfenced artifacts, and a storage lifecycle rule should eventually reap candidate objects left by a
hard process crash.
