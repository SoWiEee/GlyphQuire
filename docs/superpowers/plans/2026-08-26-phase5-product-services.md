# Phase 5 Product Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the production-oriented Phase 5 product services for assets, search, import/export, share links, and durable background jobs while preserving the existing note/version-history contracts.

**Architecture:** Add versioned contracts and a generic PostgreSQL-backed job envelope first, while retaining the strongly typed `document_jobs` outbox for note mutations. Deliver sequential vertical slices for storage/assets, search/worker, import/export, and share/lifecycle, then connect the Web workbench and run one cross-service acceptance flow. Every slice owns its migration, authorization, scrubbed errors/logging, idempotency, and integration tests. Assets support the §40.3 five-megabyte burst workload; availability and horizontal scale remain non-goals.

**Tech Stack:** Node.js 22+, pnpm 9+, TypeScript strict, Vue 3, Hono, Zod, Drizzle ORM, PostgreSQL 16, MinIO/S3-compatible storage, document-engine, Vitest, Playwright with the existing Chrome.

## Global Constraints

- Canonical persisted source remains Markdown; existing version history, CAS, auth, runtime sandbox, and `document_jobs` behavior are backward compatible.
- Expected deployment has at most five concurrent users; high availability, multi-region storage, and horizontal scale are non-goals.
- All workspace/note/asset/job identifiers are UUIDs; authenticated principal identifiers remain opaque text values, and authorization is derived server-side from the principal and current membership.
- All public request/response schemas live in `packages/api-contract`; list/search cursors are deterministic and page sizes are bounded.
- Retryable creates, uploads, imports, and exports require `Idempotency-Key`; mutation races use CAS or equivalent conditional writes.
- PostgreSQL migrations are forward-only, numbered after `0004_phase3_themes.sql`, journal/hash verified, fresh/upgrade/rerun tested, and never repair `0000`–`0004` bytes.
- Migration commands use `MIGRATION_DATABASE_URL` with the migration role only; API/worker runtime tests use `DATABASE_URL` with the runtime role and assert DDL, journal writes, sequence resets, and role escalation are denied.
- Logs contain request ids and stable error codes but never Markdown, tokens, cookies, SQL, stack traces, or raw provider errors.
- File uploads and archives enforce byte, MIME, filename, file-count, expanded-size, traversal, symlink, and quota limits before durable references are committed.
- Workers are at-least-once, idempotent, stale-revision aware, bounded-retry, and DLQ-capable; required dependency initialization fails closed.
- Deterministic worker bounds are `JOB_LOCK_TIMEOUT_SECONDS=300`, `JOB_MAX_ATTEMPTS=5`, `JOB_BACKOFF_BASE_SECONDS=5`, `JOB_BACKOFF_CAP_SECONDS=300`, and `JOB_BACKOFF_SECONDS(attempt)=min(300, 5*2^(attempt-1))`; tests use an injected clock and never sleep for these cases.
- Idempotency records use `IDEMPOTENCY_LEASE_SECONDS=60`; concurrent same-hash callers receive `in_progress`, and a crashed owner can be taken over only after the lease expires.
- Irreversible cleanup is delayed and auditable: `ASSET_DELETE_GRACE_DAYS=30`, `EXPORT_RETENTION_DAYS=30`, `IMPORT_STAGING_GRACE_SECONDS=3600`, `SHARE_DELETE_GRACE_SECONDS=3600`, `VERSION_RETENTION_DAYS=30`, `IDEMPOTENCY_RETENTION_DAYS=30`, `WORKSPACE_PURGE_GRACE_SECONDS=86400`, and `DELETION_DEADLINE_DAYS=30`; `SHARE_CLEANUP_BATCH_SIZE=100`, `ASSET_CLEANUP_BATCH_SIZE=100`, `EXPORT_CLEANUP_BATCH_SIZE=100`, `IMPORT_CLEANUP_BATCH_SIZE=100`, `VERSION_CLEANUP_BATCH_SIZE=100`, and `IDEMPOTENCY_CLEANUP_BATCH_SIZE=100` bound every scan. Structured audit/security logs use a platform TTL of `AUDIT_LOG_RETENTION_DAYS=90`; the application never logs document bodies, credentials, or secrets. A cleanup job must recheck the grace timestamp and record an actor/job id before deletion; revocation is immediately effective even while physical removal waits for its grace period.
- `PHASE5_OPERATOR_IDS` is a comma-separated allowlist of at most 20 non-empty auth IDs (each ≤200 UTF-8 bytes); whitespace, wildcard, duplicate, or empty entries fail environment parsing and prevent startup rather than widening access.
- Do not modify `README.md` or README-specific tests; this document is the source of truth for Phase 5 implementation scope.

## Security References

- Apply the [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) and [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) controls to multipart parsing, MIME/content validation, storage keys, and error handling.
- Use PostgreSQL's [privilege and role guidance](https://www.postgresql.org/docs/current/ddl-priv.html) for migration/runtime separation and tenant authorization; do not treat client workspace identifiers as authority.
- Follow the [ZIP path traversal](https://security.snyk.io/research/zip-slip-vulnerability) mitigations for canonical relative paths, symlink rejection, and expansion limits.
- Keep MinIO/S3 credentials server-side and use the provider's [presigned URL guidance](https://min.io/docs/minio/linux/integrations/presigned-put-upload.html) only for short-lived, authorized downloads.

---

## File and Ownership Map

The implementation must preserve these boundaries. A task may add tests beside its owned source, but must not edit another task's owned source without an explicit integration handoff.

| Area              | Owned paths and responsibility                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts  | `packages/api-contract/src/{jobs,assets,search,transfer,share-links,maintenance}/`; request/response schemas, error codes, public types, exports; `maintenance/` is a sequential Task 7 handoff |
| Generic jobs      | `packages/database/src/schema/jobs.ts`, `packages/database/src/migrations/0005_phase5_jobs.sql`, `packages/queue/src/jobs.ts`, `apps/worker/`                                                   |
| Storage/assets    | `packages/storage/src/{index,s3,minio}.ts`, database `assets` schema/migration, `apps/api/src/modules/assets/`, `apps/api/src/routes/v1/assets.ts`                                              |
| Search            | `packages/search/`, database `search_documents` schema/migration, `apps/api/src/modules/search/`, worker search handlers                                                                        |
| Transfer          | database `imports`/`exports` schemas/migration, `apps/api/src/modules/transfer/`, `apps/api/src/routes/v1/transfer.ts`, archive helpers                                                         |
| Sharing           | database `share_links` schema/migration, `apps/api/src/modules/share-links/`, `apps/api/src/routes/v1/share-links.ts` and public route                                                          |
| Web integration   | `apps/web/src/api/Phase5Client.ts`, `apps/web/src/components/{assets,search,transfer,share}/`, stores and route wiring                                                                          |
| Final integration | `apps/api/src/app.ts`, `apps/api/src/env.ts`, `apps/web/src/router/index.ts`, `tests/e2e/phase5.spec.ts`, deployment/runbook docs                                                               |

Each migration task must update `packages/database/src/schema/index.ts`, `packages/database/src/index.ts`, Drizzle metadata, and the migration catalog through the existing `pnpm db:generate`/verification workflow. Migration journal edits and shared files are sequential handoffs: only the active task may write them, and the next task starts only after the prior commit is green.

The task order is strict. `apps/api/src/app.ts` and `apps/web/src/router/index.ts` are reserved for Task 8 route wiring; earlier tasks expose self-contained services/routes and test them at their route seam. `packages/api-contract` is created by Task 1 and consumed thereafter. `apps/worker/src/registry.ts` is extended only at the named sequential handoff in Tasks 4–7; no tasks run concurrently against the same file.

---

### Task 1: Shared API Contracts and Generic Job Envelope

**Files:**

- Create: `packages/api-contract/src/jobs/{schemas,types}.ts`, `assets/{schemas,types}.ts`, `search/{schemas,types}.ts`, `transfer/{schemas,types}.ts`, `share-links/{schemas,types}.ts`
- Modify: `packages/api-contract/src/index.ts`, `packages/api-contract/src/notes/errors.ts` (add stable Phase 5 codes only)
- Create: `packages/api-contract/src/phase5-contracts.test.ts`
- Create: `packages/database/src/schema/jobs.ts`, `packages/database/src/schema/idempotency-records.ts`, `packages/database/src/migrations/0005_phase5_jobs.sql`, `packages/database/src/migrations/meta/0005_snapshot.json`
- Create: `packages/database/src/migrations/phase5-jobs.integration.test.ts`
- Create: `packages/database/src/idempotency.ts`
- Modify: `packages/database/src/migrations/meta/_journal.json` through the generated migration workflow
- Modify: `packages/database/src/schema/index.ts`, `packages/database/src/index.ts`, `packages/database/package.json` (add `zod` for response-schema parsing)
- Create: `packages/queue/src/jobs.ts`, `packages/queue/src/jobs.test.ts`
- Modify: `packages/queue/src/index.ts`, `packages/queue/package.json` (add `zod` for strict job payload validation)
- Create: `apps/worker/{package.json,tsconfig.json,src/index.ts,src/runtime.ts,src/registry.ts,src/runtime.test.ts}`; the manifest depends on `@glyphquire/database`, `@glyphquire/queue`, and `@glyphquire/shared` and is extended with `@glyphquire/storage`/`@glyphquire/search` at their sequential handoffs
- Modify: `packages/shared/src/env.ts`, `.env.example` (add `IDEMPOTENCY_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`, `IDEMPOTENCY_LEASE_SECONDS=60`, `PHASE5_OPERATOR_IDS` as a comma-separated opaque auth-id allowlist, `THUMBNAIL_MAX_SOURCE_BYTES=5242880`, `THUMBNAIL_MAX_PIXELS=40000000`, `THUMBNAIL_MAX_OUTPUT_BYTES=262144`, `ASSET_MAX_BYTES=5242880`, `AUDIT_LOG_RETENTION_DAYS=90`, `DELETION_DEADLINE_DAYS=30`, and the exact `JOB_*`/cleanup/retention defaults once; later tasks consume these values)
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces `JobType = "search.index" | "search.remove" | "search.rebuild" | "asset.cleanup" | "asset.orphan_cleanup" | "asset.thumbnail" | "import" | "import.cleanup" | "export" | "export.expire" | "share.cleanup" | "version.retention" | "idempotency.cleanup" | "backup.verify" | "workspace.purge" | "account.purge"` and `JobEnvelope<TType extends JobType> = { id: string; workspaceId: string | null; type: TType; version: number; attempts: number; createdAt: string; payload: JobPayload<TType> }`. `workspaceId` is a routing hint, not the durable lifecycle target: it is nullable and uses `ON DELETE SET NULL`; destructive/global payloads retain their UUID/text targets so a final workspace deletion, zero-workspace account, or deployment-wide backup can still be acknowledged durably.
- Produces exact version-1 payload schemas and static handler mappings for each `JobType`: `search.index { workspaceId, noteId, revision, operationId }`, `search.remove { workspaceId, noteId, revision, operationId }`, `search.rebuild { workspaceId, scope: "note", noteId, batchSize: 1, cursor? } | { workspaceId, scope: "workspace", batchSize: 1..100, cursor? }`, `asset.cleanup { workspaceId, assetId }`, `asset.orphan_cleanup { workspaceId, batchSize: 1..100, cursor? }`, `asset.thumbnail { workspaceId, assetId }`, `import { workspaceId, importId, actorId (text), noteId?, baseRevision? }`, `import.cleanup { workspaceId, scope: "one", importId } | { workspaceId, scope: "staging", batchSize: 1..100, cursor? }`, `export { workspaceId, exportId }`, `export.expire { workspaceId, batchSize: 1..100, cursor? }`, `share.cleanup { workspaceId, scope: "one", shareLinkId } | { workspaceId, scope: "expired", batchSize: 1..100, cursor? }`, `version.retention { workspaceId, scope: "note", noteId, batchSize: 1 } | { workspaceId, scope: "workspace", batchSize: 1..100, cursor? }`, `idempotency.cleanup { workspaceId, batchSize: 1..100, cursor? }`, `backup.verify { workspaceId: string | null, backupId }`, `workspace.purge { workspaceId, deletionId }`, and `account.purge { workspaceId: string | null, accountDeletionId, accountId (text) }`. Every payload is `.strict()`, bounded, and validated before dispatch; handlers load source rows and derive object keys and authorization from the database.
- Defines `P0_JOB_TYPES = ["search.index", "search.remove", "search.rebuild", "asset.cleanup", "import", "import.cleanup", "export", "export.expire", "share.cleanup", "version.retention", "workspace.purge", "account.purge", "backup.verify"] as const`; `assertRegistryComplete(registry, P0_JOB_TYPES)` is the activation gate, while P1 handlers may be added incrementally until the final release gate.
- Defines `P1_JOB_TYPES = ["asset.thumbnail", "asset.orphan_cleanup", "idempotency.cleanup"] as const`; P1 completeness is reported by a separate `assertPhase5Complete(registry)` diagnostic and never blocks initial P0 worker activation or release. A later Phase 5 completion gate may require `assertRegistryComplete(registry, [...P0_JOB_TYPES, ...P1_JOB_TYPES])` once those optional handlers are deliberately enabled.
- Produces `JobDispatcher.enqueue<TType>(input: { workspaceId: string | null; type: TType; payload: JobPayload<TType>; idempotencyKey?: string; runAt?: Date; maxAttempts?: number }): Promise<{ id: string; duplicate: boolean }>` and `dispatchBatch(handlers): Promise<DispatchSummary>`.
- `JobHandler<TType>` is a static `(job: JobEnvelope<TType>, signal: AbortSignal) => Promise<void>`; the staged registry is `{ [K in JobType]?: JobHandler<K> }`, rejects unregistered types fail-closed, and requires every P0 handler before activation. A database value can never select an arbitrary module.
- `assertRegistryComplete(registry, requiredTypes = P0_JOB_TYPES): void` is the only activation gate; it enumerates the exact required list, rejects missing or extra unrecognized keys, and is tested separately from staged development dispatch.
- Produces `IdempotencyStore.begin<TResponse>({ workspaceId, actorId, operation, key, requestHash, responseSchema: z.ZodType<TResponse> }): Promise<{ kind: "new"; recordId: string; leaseToken: string } | { kind: "in_progress"; retryAfterSeconds: number } | { kind: "conflict" } | { kind: "replay"; response: TResponse }>` and `complete(recordId, leaseToken, response): Promise<void>`; the store owns AES-256-GCM encryption/decryption with a versioned `{version,iv,ciphertext,tag}` envelope under `IDEMPOTENCY_ENCRYPTION_KEY`, hashes only the lease token, atomically completes only the current lease owner, takes over records after `IDEMPOTENCY_LEASE_SECONDS=60`, parses the decrypted response with the supplied schema before returning replay data, and never exposes ciphertext or plaintext share tokens to persistence. A new record cannot be completed twice with a different response.
- `AssetResponse` includes `thumbnailStatus`, `thumbnailMimeType?`, `thumbnailWidth?`, `thumbnailHeight?`, `thumbnailBytes?`, and an authorized `thumbnailUrl?`; all thumbnail fields are derived server-side and omitted when status is `metadata_only` or `failed`.
- Produces bounded `cursorSchema`, `idempotencyKeySchema`, and stable error codes `ASSET_INVALID`, `SEARCH_UNAVAILABLE`, `IMPORT_INVALID`, `EXPORT_FAILED`, `SHARE_NOT_FOUND`, `JOB_INVALID`, and `JOB_FAILED`.

- [ ] **Step 1: Write the failing contract tests.** Assert exact keys, UUIDs, positive versions/attempts, bounded payload sizes, canonical cursor encoding, idempotency key length/charset, and rejection of unknown job types or prototype-polluted payloads. Assert every public contract is exported from `@glyphquire/api-contract`; exercise concurrent `begin` (`new` plus `in_progress`), crash-before-complete takeover after 60 seconds, `begin → complete → replay`, same-key/different-hash conflict, tampered ciphertext/tag rejection, and caller-schema rejection without returning raw ciphertext. Test partial staged dispatch succeeds only for registered keys, while `assertRegistryComplete(partial, P0_JOB_TYPES)` fails with the missing exact key (including `search.rebuild`) and succeeds only when all thirteen P0 handlers are present; `assertPhase5Complete` reports missing P1 handlers without failing the P0 gate.

```ts
it("rejects an envelope with unknown type, extra keys, or oversized payload", () => {
  expect(jobEnvelopeSchema.safeParse({ type: "shell.exec" })).toMatchObject({ success: false });
  expect(
    jobEnvelopeSchema.safeParse({
      id: crypto.randomUUID(),
      type: "search.index",
      version: 1,
      attempts: 0,
      createdAt: new Date().toISOString(),
      payload: { __proto__: {} },
      extra: 1,
    }),
  ).toMatchObject({ success: false });
});
```

- [ ] **Step 2: Run the focused tests to verify RED.**

Run: `pnpm --filter @glyphquire/api-contract test -- src/phase5-contracts.test.ts` and `pnpm --filter @glyphquire/queue test -- src/jobs.test.ts`

Expected: FAIL because the new schemas, job table, and dispatcher do not exist.

- [ ] **Step 3: Add the migration and strict schemas.** Define `jobs` with UUID primary key, nullable routing `workspace_id` using `ON DELETE SET NULL`, `type`, `version`, JSONB payload, `status` (`pending|processing|completed|dead_letter`), attempts, persisted `max_attempts` (1–20), lock/availability timestamps, idempotency key, sanitized error, and a scoped unique `(COALESCE(workspace_id, zero-UUID), type, idempotency_key)` index for non-null keys so global jobs retain idempotency when their routing workspace is null. Add a check that `workspace_id IS NOT NULL` for ordinary workspace jobs and permits NULL only for `workspace.purge`, `account.purge`, and `backup.verify`; those payloads retain their durable targets. The current lifecycle job is explicitly excluded from bulk deletion and is acknowledged after its target rows are removed. Keep payload validation in TypeScript and never execute payload-provided SQL or module names. Add `JOB_FAILED` to the stable error map for terminal worker failures.

```sql
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  type varchar(80) NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(200),
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  idempotency_key varchar(200),
  last_error varchar(4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jobs ADD CONSTRAINT jobs_scope_check CHECK (
  workspace_id IS NOT NULL OR type IN ('workspace.purge', 'account.purge', 'backup.verify')
);

CREATE UNIQUE INDEX jobs_idempotency_scope_idx
  ON jobs (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  operation varchar(80) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  response_ciphertext text,
  owner_token_hash char(64),
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, actor_id, operation, idempotency_key),
  CHECK ((response_ciphertext IS NULL AND completed_at IS NULL AND owner_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL) OR
         (response_ciphertext IS NOT NULL AND completed_at IS NOT NULL AND owner_token_hash IS NULL AND lease_expires_at IS NULL))
);
```

- [ ] **Step 4: Implement atomic claim/retry/DLQ runtime and idempotency leases.** Use `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`; reclaim locks older than `JOB_LOCK_TIMEOUT_SECONDS`, increment attempts exactly once, schedule `min(JOB_BACKOFF_CAP_SECONDS, JOB_BACKOFF_BASE_SECONDS*2^(attempt-1))`, truncate errors to 4000 characters, and mark terminal states only when the current dispatcher owns the lock. Implement the idempotency lease owner hash/expiry and atomic completion/takeover rules; Task 7 owns the deterministic 30-day `idempotency.cleanup` retention job. Inject clocks into `apps/worker/src/runtime.ts` and `packages/database/src/idempotency.ts` so tests assert reclaim/backoff/lease expiry without sleeping; the runtime accepts an explicit partial handler map and never dynamically imports a job type from a database value.

- [ ] **Step 5: Run GREEN gates and commit.** Validate invalid, zero, and over-limit thumbnail/asset environment values fail startup rather than silently widening limits.

Run: `pnpm --filter @glyphquire/api-contract test -- src/phase5-contracts.test.ts`; `pnpm --filter @glyphquire/queue test -- src/jobs.test.ts`; `pnpm --filter @glyphquire/worker test`; `pnpm --filter @glyphquire/database generate`; fresh migration plus upgrade from exact `0004_phase3_themes` and rerun; `pnpm --filter @glyphquire/database test -- src/migrations/phase5-jobs.integration.test.ts` (rollback, runtime-role DDL/journal denial, malformed payload); `pnpm typecheck`.

Expected: all focused tests and typechecks pass; migration journal includes exactly `0005_phase5_jobs`.

```bash
git add packages/api-contract packages/database packages/queue packages/shared apps/worker .env.example pnpm-lock.yaml
git commit -m "feat: add phase5 contracts and generic jobs"
```

---

### Task 2: Assets, Object Storage, and Upload Authorization

**Files:**

- Create: `packages/database/src/schema/assets.ts`, `packages/database/src/migrations/0006_phase5_assets.sql`, `packages/database/src/migrations/meta/0006_snapshot.json`
- Create: `packages/database/src/migrations/phase5-assets.integration.test.ts`, `apps/api/src/modules/assets/storage-privilege.integration.test.ts`
- Modify: `packages/database/src/migrations/meta/_journal.json` through the generated migration workflow
- Modify: `packages/database/src/schema/index.ts`, `packages/database/src/index.ts`
- Replace/adapt: `packages/storage/src/index.ts`
- Create: `packages/storage/src/s3.ts`, `packages/storage/src/minio.ts`, `packages/storage/src/storage.test.ts`
- Modify: `packages/storage/package.json` (add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`), `pnpm-lock.yaml`
- Create: `apps/api/src/modules/assets/{AssetService,limits}.ts`, `AssetService.integration.test.ts`
- Create: `apps/api/src/routes/v1/assets.ts`, `apps/api/src/routes/v1/assets.integration.test.ts`
- Create: `apps/worker/src/handlers/asset-thumbnail.ts`, `apps/worker/src/handlers/asset-thumbnail.test.ts` (metadata/thumbnail job seam; registry registration is handed to Task 4)
- Modify: `apps/worker/package.json` (add `@glyphquire/storage` workspace dependency and approved `sharp` decoder), `pnpm-lock.yaml`
- Modify: `apps/api/package.json` to depend on `@glyphquire/storage`

**Interfaces:**

- Produces `ObjectStoragePort.put({ key, body, contentType, contentLength, sha256 }): Promise<{ etag: string }>`; `get(key): Promise<ReadableStream<Uint8Array>>`; `delete(key): Promise<void>`; `createDownloadUrl(key, expiresInSeconds): Promise<string>`.
- Produces `AssetService.create(actorId, workspaceId, input, idempotencyKey)`, `get(actorId, assetId)`, and `delete(actorId, assetId, idempotencyKey)`, each returning validated API-contract types and using Task 1's `IdempotencyStore` for replay/conflict semantics.
- Produces a bounded `asset.thumbnail` handler seam that records `thumbnail_status (pending|ready|metadata_only|failed)`, dimensions, byte count, MIME, and a server-derived `thumbnail_object_key` from server-read object bytes; it never trusts client MIME, invokes an unapproved binary parser, or emits active SVG/HTML. The worker uses the approved `sharp` decoder with `THUMBNAIL_MAX_SOURCE_BYTES=5242880`, `THUMBNAIL_MAX_PIXELS=40000000`, `THUMBNAIL_MAX_OUTPUT_BYTES=262144`, and a 256×256 WebP output cap; unsupported formats become `metadata_only` with a scrubbed error.
- Produces `POST /api/v1/workspaces/:workspaceId/assets`, `GET /api/v1/assets/:assetId`, `GET /api/v1/assets/:assetId/download`, `GET /api/v1/assets/:assetId/thumbnail`, and `DELETE /api/v1/assets/:assetId`; all route responses are contract-validated and unauthorized assets resolve uniformly without metadata leakage.

- [ ] **Step 1: Write RED tests at the service and storage seams.** Cover membership denial, the exact `ASSET_MAX_BYTES = 5 * 1024 * 1024` boundary, actual-vs-declared length mismatch, MIME spoof, filename normalization, quota, duplicate idempotency and request-hash conflict, object-key derivation, soft delete, `ASSET_DELETE_GRACE_DAYS` clock boundary, expired download URL, SVG non-inline content, and thumbnail ready/metadata-only/failed status, decoder pixel cap, output byte cap, and thumbnail download authorization. Add failure injection for both object-written/DB-failed compensation and DB-written/object-failed rollback; delete uses the same durable idempotency replay/conflict path. Storage tests use an in-memory fake implementing `ObjectStoragePort`; integration tests use real MinIO and PostgreSQL.

- [ ] **Step 2: Run RED.**

Run: `pnpm --filter @glyphquire/storage test -- src/storage.test.ts` and `pnpm --filter @glyphquire/api test:integration -- src/routes/v1/assets.integration.test.ts`

Expected: FAIL with missing `assets` table, adapter, and service.

- [ ] **Step 3: Add schema and strict streaming limits.** Create `assets` with the design fields plus `thumbnail_status`, `thumbnail_object_key`, `thumbnail_mime_type`, `thumbnail_width`, `thumbnail_height`, `thumbnail_bytes`, and `metadata_json`; enforce workspace/owner FKs, positive byte-size check, SHA-256 format check, unique `(workspace_id, object_key)`, and `deleted_at`. Set `ASSET_MAX_BYTES` to `5 * 1024 * 1024` by default to cover the §40.3 burst workload, and `ASSET_WORKSPACE_QUOTA_BYTES` to `100 * 1024 * 1024`. Generate object keys only from server UUIDs. Buffer no more than the configured limit; hash and count bytes while streaming before metadata commit.

- [ ] **Step 4: Implement S3-compatible adapters.** Use one provider-neutral client boundary; MinIO uses endpoint/path-style configuration, while production S3/R2 settings remain environment-driven. Never expose provider credentials or raw SDK errors. Normalize filenames to a safe display name and store the original object under `workspace/{workspaceId}/assets/{assetId}/original`; thumbnails use `.../thumbnail.webp` and are never inline SVG/HTML.

- [ ] **Step 5: Implement API service/routes.** Parse multipart fields without trusting client workspace/owner/key values, require membership before storage access, use idempotency rows/unique constraints to replay safely, soft-delete metadata first, and enqueue `asset.cleanup` through Task 1's dispatcher.

- [ ] **Step 6: Run GREEN and migration gates.**

Run: `docker compose up -d postgres minio`; `pnpm --filter @glyphquire/database test -- src/migrations/phase5-assets.integration.test.ts` (fresh `0000`–`0006`, exact `0004_phase3_themes` upgrade, rerun, transactional rollback preserving rows, journal/hash integrity, runtime-role DDL/journal denial); `pnpm --filter @glyphquire/api test:integration -- src/modules/assets/storage-privilege.integration.test.ts` (MinIO bucket-policy denial); real PostgreSQL/MinIO integration; `pnpm --filter @glyphquire/storage test`; `pnpm --filter @glyphquire/api typecheck`; `pnpm typecheck`; `pnpm lint`.

Expected: fresh/upgrade/rerun migrations pass, unauthorized assets return uniform 404/403 without metadata leakage, and no secrets/content appear in logs.

```bash
git add packages/database packages/storage apps/api/package.json apps/api/src/modules/assets apps/api/src/routes/v1/assets.ts apps/api/src/routes/v1/assets.integration.test.ts apps/worker/package.json apps/worker/src/handlers/asset-thumbnail.ts apps/worker/src/handlers/asset-thumbnail.test.ts pnpm-lock.yaml
git commit -m "feat: add authorized asset storage"
```

---

### Task 3: Search Documents, Extraction, and Revision-Aware Search API

**Files:**

- Create: `packages/database/src/schema/search-documents.ts`, `packages/database/src/migrations/0007_phase5_search.sql`, `packages/database/src/migrations/meta/0007_snapshot.json`
- Create: `packages/database/src/migrations/phase5-search.integration.test.ts`, `apps/api/src/modules/search/search-privilege.integration.test.ts`
- Modify: `packages/database/src/migrations/meta/_journal.json` through the generated migration workflow
- Modify: `packages/database/src/schema/index.ts`, `packages/database/src/index.ts`
- Create: `packages/search/{package.json,tsconfig.json,src/{index,types,extract,postgres}.ts,tests/search.test.ts}`; its manifest depends on `@glyphquire/database`, `@glyphquire/document-engine`, and `@glyphquire/shared`
- Consume: `packages/document-engine/src/index.ts` existing `extractText` export; no document-engine source change is required
- Create: `apps/api/src/modules/search/{SearchService,SearchService.integration.test}.ts`, `apps/api/src/routes/v1/search.ts`, `apps/api/src/routes/v1/search.integration.test.ts`
- Create: `apps/api/src/routes/v1/search-operator.integration.test.ts`
- Create: `apps/worker/src/handlers/search-rebuild-note.ts`, `apps/worker/src/handlers/search-rebuild-note.test.ts`
- Modify: `apps/worker/src/registry.ts` (register the P0 one-note rebuild handler in the staged registry; full P0 activation remains gated until Task 7 registers every required handler)
- Modify: `apps/api/package.json` (add the search package workspace dependency)
- Modify: `pnpm-lock.yaml` (record the search package dependency handoff)

**Interfaces:**

- Produces `SearchPort.indexNote(note: SearchableNote): Promise<void>`, `removeNote(noteId: string): Promise<void>`, `search(query: SearchQuery): Promise<SearchResult[]>`.
- `SearchableNote` contains `noteId`, `workspaceId`, `revision`, `title`, `headings`, `body`, `tags`, and `normalizedText`; no raw Markdown is logged.
- Produces `GET /api/v1/search` and an operator-only bounded one-note rebuild endpoint consuming the `scope:"note"` branch of the exact `search.rebuild` union from Task 1 (`noteId` and `batchSize:1`, optional cursor); normal members cannot start an unbounded rebuild. The workspace branch is intentionally not accepted or registered until Task 7's scheduler handoff.
- `OperatorAuthorizer` consumes the parsed `PHASE5_OPERATOR_IDS` opaque text allowlist, requires an exact authenticated actor id, and fails closed when the allowlist is empty or malformed; the route middleware and denial tests are owned here and do not add a membership role.

- [ ] **Step 1: Write RED extraction and authorization tests.** Assert headings/body extraction from canonical Markdown excludes runtime code, preserves CJK text, normalizes case/whitespace deterministically, rejects payloads over the configured text bound, filters deleted notes and unauthorized workspaces, and returns stable cursor ordering. Assert the note rebuild branch requires `noteId`/`batchSize:1`, the workspace branch forbids `noteId` and bounds `batchSize:1..100`, a normal owner/editor is denied, an exact configured operator is allowed, and an empty/malformed `PHASE5_OPERATOR_IDS` value is denied and audited without leaking actor ids.

- [ ] **Step 2: Run RED.**

Run: `pnpm --filter @glyphquire/search test -- tests/search.test.ts` and `pnpm --filter @glyphquire/api test:integration -- src/routes/v1/search.integration.test.ts`

Expected: FAIL because `packages/search`, table, indexes, and routes do not exist.

- [ ] **Step 3: Add search schema/indexes.** Create one row per note with indexed revision, extracted fields, normalized text, and generated `tsvector`; enable `pg_trgm` and add GIN/trigram indexes. Keep workspace and note FKs and a unique note key.

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX search_documents_tsv_idx ON search_documents USING gin (search_vector);
CREATE INDEX search_documents_normalized_trgm_idx ON search_documents USING gin (normalized_text gin_trgm_ops);
```

- [ ] **Step 4: Implement extraction and PostgreSQL adapter.** Use document-engine parse/semantic normalization as the source of searchable text, map title/headings/body/tags explicitly, select tokenized search for English and trigram fallback for CJK/fuzzy terms, and filter `deleted_at`/workspace membership in the query itself.

- [ ] **Step 5: Implement API and stale-revision behavior.** `GET /api/v1/search` validates `workspaceId`, q, cursor, and page size from shared schemas. An index write with revision lower than the stored revision is a no-op; a note remove is idempotent. Add an operator-only bounded rebuild route that accepts only the `scope:"note"` branch from Task 1 (exactly one note, `batchSize:1`); reject the workspace branch until Task 7's sequential handoff. Register the P0 one-note handler here; Task 7 extends the same handler to scheduled workspace scans.

- [ ] **Step 6: Run GREEN and commit.**

Run: `pnpm --filter @glyphquire/database test -- src/migrations/phase5-search.integration.test.ts` (fresh `0000`–`0007`, exact `0004_phase3_themes` upgrade, rerun, transactional rollback preserving notes, journal/hash integrity, runtime-role DDL/journal denial); `pnpm --filter @glyphquire/api test:integration -- src/modules/search/search-privilege.integration.test.ts`; real PostgreSQL search integration; `pnpm --filter @glyphquire/search test`; API search integration; `pnpm test:cross-package`; `pnpm typecheck`.

```bash
git add packages/database packages/search apps/api/package.json apps/api/src/modules/search apps/api/src/routes/v1/search.ts apps/api/src/routes/v1/search.integration.test.ts apps/api/src/routes/v1/search-operator.integration.test.ts apps/worker/src/handlers/search-rebuild-note.ts apps/worker/src/handlers/search-rebuild-note.test.ts apps/worker/src/registry.ts pnpm-lock.yaml
git commit -m "feat: add tenant-safe full-text search"
```

---

### Task 4: Worker Consumers and Transactional Search/Asset Jobs

**Files:**

- Modify: `apps/worker/src/{index,runtime}.ts`
- Create: `apps/worker/src/handlers/{search-index,search-remove,asset-cleanup}.ts`
- Create: `apps/worker/src/handlers/handlers.test.ts`, `apps/worker/src/integration/worker.integration.test.ts`
- Modify: `apps/worker/package.json` (add `@glyphquire/storage` and `@glyphquire/search` workspace dependencies), `pnpm-lock.yaml`
- Modify: `apps/worker/src/registry.ts` (static handler handoff from Task 1)
- Modify: `apps/api/src/modules/notes/NoteService.ts`, `apps/api/src/modules/notes/NoteService.integration.test.ts`
- Modify: `apps/api/src/modules/notes/NoteWriter.ts`, `apps/api/src/modules/notes/NoteWriter.integration.test.ts`
- Modify: `apps/api/src/modules/assets/AssetService.ts`
- Modify: `packages/queue/src/jobs.ts`
- Create: `docs/deployment/phase5-worker-runbook.md`

**Interfaces:**

- Produces handler map `{ "search.index": handleSearchIndex, "search.remove": handleSearchRemove, "search.rebuild": handleSearchRebuildNote, "asset.cleanup": handleAssetCleanup, "asset.thumbnail": handleAssetThumbnail }` registered statically at worker startup; later tasks extend this map only with the `JobType` union from Task 1.
- Note create/rename/save/checkpoint/restore paths in `NoteService.ts`/`NoteWriter.ts` enqueue exactly one derived `search.index` job per committed revision, and soft-delete paths enqueue exactly one `search.remove` job in the same database transaction. The existing `document_jobs` outbox remains authoritative for note mutation processing; generic `jobs` is authoritative only for derived search/asset side effects, with operation IDs and unique keys preventing duplicate emission.
- `NoteService` retains its existing `list/create/get/rename/softDelete/restore/save/checkpoint/restoreVersion` signatures; this task adds only the transactional derived-job insertion and preserves the public note result shapes.

- [ ] **Step 1: Write RED handler tests.** Cover duplicate delivery, out-of-order revisions, note deletion during processing, object already absent, thumbnail metadata idempotency, ready/metadata-only/failed thumbnail statuses, decoder pixel/output caps, worker restart/reclaim at the five-minute lock boundary, exact 5/20-attempt retry/DLQ limits and 5/10/20-second backoff, and sanitized error persistence. Assert a failed handler does not mark the source mutation as failed after its transaction commits.

- [ ] **Step 2: Run RED.**

Run: `pnpm --filter @glyphquire/worker test -- src/handlers/handlers.test.ts`

Expected: FAIL because handlers are not registered and NoteWriter emits only the existing document job.

- [ ] **Step 3: Implement transactional enqueue and handlers.** Add generic job insertion to the same Drizzle transaction used by `NoteService`/`NoteWriter` and `AssetService`. Search handlers read the current note and no-op stale jobs; cleanup verifies soft-delete age and deletes only the server-derived object key. All provider errors map to `JOB_FAILED` with scrubbed messages. Do not enqueue generic jobs from a post-commit hook, and do not make a generic job failure roll back the already-committed note mutation.

- [ ] **Step 4: Implement worker process lifecycle.** Load env through `packages/shared` schemas, initialize database/storage/search before consuming, stop claiming on SIGTERM, finish or release owned locks, and return non-zero on dependency initialization failure. Do not detach the process in tests.

- [ ] **Step 5: Run GREEN and commit.**

Run: real PostgreSQL two-dispatcher concurrency tests; `pnpm --filter @glyphquire/worker test`; `pnpm --filter @glyphquire/queue test:integration`; NoteWriter integration; `pnpm typecheck`; `pnpm build`.

```bash
git add apps/worker/package.json apps/worker/src/index.ts apps/worker/src/runtime.ts apps/worker/src/registry.ts apps/worker/src/handlers/search-index.ts apps/worker/src/handlers/search-remove.ts apps/worker/src/handlers/asset-cleanup.ts apps/worker/src/handlers/handlers.test.ts apps/worker/src/integration/worker.integration.test.ts apps/api/src/modules/notes/NoteService.ts apps/api/src/modules/notes/NoteService.integration.test.ts apps/api/src/modules/notes/NoteWriter.ts apps/api/src/modules/notes/NoteWriter.integration.test.ts apps/api/src/modules/assets/AssetService.ts packages/queue/src/jobs.ts docs/deployment/phase5-worker-runbook.md pnpm-lock.yaml
git commit -m "feat: process phase5 jobs safely"
```

---

### Task 5: Bounded Import and Durable Export Services

**Files:**

- Create: `packages/database/src/schema/exports.ts`, `packages/database/src/schema/imports.ts`, `packages/database/src/schema/import-resources.ts`, `packages/database/src/migrations/0008_phase5_exports.sql`, `packages/database/src/migrations/meta/0008_snapshot.json`
- Create: `packages/database/src/migrations/phase5-transfer.integration.test.ts`
- Modify: `packages/database/src/migrations/meta/_journal.json` through the generated migration workflow
- Modify: `packages/database/src/schema/index.ts`, `packages/database/src/index.ts` (including the Task 5-owned `import_resources` staging relation; no Task 2 asset-schema edits)
- Create: `apps/api/src/modules/transfer/{ArchiveLimits,ArchiveReader,ImportService,ExportService}.ts`
- Create: `apps/api/src/modules/transfer/transfer.integration.test.ts`
- Create: `apps/api/src/modules/transfer/storage-privilege.integration.test.ts`
- Create: `apps/api/src/routes/v1/transfer.ts`, `apps/api/src/routes/v1/transfer.integration.test.ts`
- Modify: `apps/api/package.json` (add the selected archive dependency `fflate`), `pnpm-lock.yaml`
- Create: `apps/worker/src/handlers/{import,import-cleanup,export}.ts`, `apps/worker/src/handlers/transfer.test.ts`, `apps/worker/src/handlers/import-recovery.integration.test.ts`
- Modify: `apps/worker/src/registry.ts` (sequential static-handler handoff), `apps/worker/package.json` (add `@glyphquire/document-engine` and `fflate`), `pnpm-lock.yaml`
- Create: `docs/deployment/phase5-transfer-runbook.md`

**Interfaces:**

- Produces `ImportService.start(actorId, workspaceId, input: { upload: Blob; noteId?: string; baseRevision?: number }, idempotencyKey): Promise<ImportJobResult>` and `ImportService.getStatus(actorId, importId): Promise<ImportJobResult>`; an `imports` row is allocated first with UUID `importId`, opaque text `actorId`, workspace/target-note scope, source object key, status (`staging|pending|processing|completed|failed|expired`), `compensation_status (none|required|running|completed|failed)`, expiry, idempotency key, manifest, and sanitized error. The staged object key is derived from `importId`; the row is committed before upload, then the external object upload occurs, and only the pending-state transition plus generic `import` job enqueue share a PostgreSQL transaction. Either object-written/DB-failed or DB-written/object-failed invokes the owning compensator. An existing-note import requires a matching `baseRevision` and persists the target `noteId` in its idempotency fingerprint.
- `ImportJobResult` includes `{ id, workspaceId, status, noteId?, progress, errorCode? }`; `progress` is a bounded manifest summary, never raw Markdown, and `getStatus` authorizes by actor/workspace before returning it.
- Task 5 owns `import_resources` as the durable staging ledger: `{ id, importId, workspaceId, assetId?, objectKey, state: declared|uploaded|promoted|cleaned, createdAt, updatedAt }`, with a strict foreign key to `imports`, a server-derived key check, and an ownership constraint that prevents cleanup from touching resources outside the import. The target note is not visible until finalization commits the sole note CAS/create together with the completed manifest.
- Produces `ExportService.start(actorId, scope, format, idempotencyKey): Promise<ExportResult>` and routes `POST /api/v1/workspaces/:workspaceId/export`, `POST /api/v1/notes/:noteId/export`, `GET /api/v1/imports/:id` for authorized import polling, plus `GET /api/v1/exports/:id` and `GET /api/v1/exports/:id/download` with owner/scope checks. Download never accepts a client object key.

- [ ] **Step 1: Write RED archive and CAS tests.** Assert Markdown import, ZIP import with asset remapping, traversal (`../`), absolute paths, symlinks, malformed ZIP, file-count/expanded-size limits, invalid custom syntax, unsupported-block preservation, existing-note `baseRevision` conflict, idempotent repeat with the same target `noteId`, `GET /api/v1/imports/:id` status authorization, and export artifact contents. Assert cross-import resources cannot be cleaned or promoted, no target note or promoted asset is visible before the single finalization transaction, cleanup preserves a resource referenced by a committed note, and retry immediately after finalization remains completed/idempotent. Inject crashes before upload, after upload, after row/job commit, during manifest update, and after finalization; assert both object-written/DB-failed and DB-written/object-failed paths eventually compensate without a durable orphan.

- [ ] **Step 2: Run RED.**

Run: `pnpm --filter @glyphquire/api test:integration -- src/modules/transfer/transfer.integration.test.ts` and `pnpm --filter @glyphquire/api test:integration -- src/routes/v1/transfer.integration.test.ts`

Expected: FAIL because the exports table, archive reader, services, routes, and worker handlers do not exist.

- [ ] **Step 3: Add transfer records and archive limits.** Store export format/status/requester/scope/idempotency/object key/expiry/sanitized error with a scoped unique `(workspace_id, requester_id, idempotency_key)` constraint, and import actor/workspace/target-note/source-key/status/idempotency/expiry/error with the same replay fingerprint. Use exact limits `MAX_ARCHIVE_BYTES = 25 * 1024 * 1024`, `MAX_ARCHIVE_FILES = 256`, `MAX_EXPANDED_BYTES = 100 * 1024 * 1024`, and `MAX_ARCHIVE_ENTRY_BYTES = 5 * 1024 * 1024`. Parse archives entry-by-entry with canonicalized relative paths, reject symlinks and expansion beyond limits, and never extract outside a dedicated temporary directory. Expired staged imports and failed compensations are cleaned only after `IMPORT_STAGING_GRACE_SECONDS=3600` by the typed `import.cleanup {workspaceId,scope:"one",importId}` job.

- [ ] **Step 4: Implement import handler and crash recovery.** Insert the `imports` staging row and its compensation lease before uploading the staged object; then upload, transactionally mark the row `pending`, and enqueue the generic job. Before each imported asset object put, insert an `import_resources` row in state `declared` and append its object key/resource id to the import manifest in the same database transaction, predeclaring cleanup ownership before the external put; after the put, atomically mark that resource `uploaded`. Validate canonical Markdown with document-engine and stage the parsed note intent without exposing a partial target note. Retries resume from the manifest with live-reference checks. Finalization is the sole visibility boundary: one transaction verifies every manifest resource is uploaded, rechecks live references, creates/promotes asset rows, applies note CAS/create, records the final manifest/result, and marks the import completed. On any failure mark `compensation_status=required` and enqueue `import.cleanup {workspaceId,scope:"one",importId}`; a periodic `import.cleanup {workspaceId,scope:"staging"}` scan discovers rows stranded before job enqueue. Cleanup deletes only staged objects and `import_resources` rows owned by that import after `IMPORT_STAGING_GRACE_SECONDS`, with a live-reference recheck that preserves anything referenced by a committed note, then records `compensation_status=completed`; a failed compensation remains visible and retryable. Restart tests cover crashes before upload, after upload, after row commit, during manifest updates, between external put and manifest finalization, and immediately after the finalization commit.

- [ ] **Step 5: Implement export handler/routes.** Generate canonical Markdown, referenced assets, metadata, ZIP or rendered HTML into server-owned storage. Mark rows `completed|failed|expired`; stream only completed artifacts after authorization and expiry checks.

- [ ] **Step 6: Run GREEN and commit.**

Run: `pnpm --filter @glyphquire/database test -- src/migrations/phase5-transfer.integration.test.ts` (fresh `0000`–`0008`, exact `0004_phase3_themes` upgrade, rerun, transactional rollback preserving pre-existing rows, journal/hash integrity, runtime-role DDL/journal denial); `pnpm --filter @glyphquire/api test:integration -- src/modules/transfer/storage-privilege.integration.test.ts` (MinIO bucket-policy denial); migration fresh/upgrade/rerun; real MinIO/PostgreSQL transfer integration; `pnpm --filter @glyphquire/worker test -- src/handlers/transfer.test.ts src/handlers/import-recovery.integration.test.ts`; `pnpm test:cross-package`; `pnpm typecheck`; `pnpm build`.

```bash
git add packages/database apps/api/package.json apps/api/src/modules/transfer apps/api/src/routes/v1/transfer.ts apps/api/src/routes/v1/transfer.integration.test.ts apps/worker/package.json apps/worker/src/handlers/import.ts apps/worker/src/handlers/import-cleanup.ts apps/worker/src/handlers/import-recovery.integration.test.ts apps/worker/src/handlers/export.ts apps/worker/src/handlers/transfer.test.ts apps/worker/src/registry.ts docs/deployment/phase5-transfer-runbook.md pnpm-lock.yaml
git commit -m "feat: add safe import and durable export"
```

---

### Task 6: Opaque Read-Only Share Links

**Files:**

- Create: `packages/database/src/schema/share-links.ts`, `packages/database/src/migrations/0009_phase5_share_links.sql`, `packages/database/src/migrations/meta/0009_snapshot.json`
- Create: `packages/database/src/migrations/phase5-share-links.integration.test.ts`
- Modify: `packages/database/src/migrations/meta/_journal.json` through the generated migration workflow
- Modify: `packages/database/src/schema/index.ts`, `packages/database/src/index.ts`
- Create: `apps/api/src/modules/share-links/{ShareLinkService,ShareLinkService.integration.test}.ts`
- Create: `apps/api/src/routes/v1/share-links.ts`, `apps/api/src/routes/shared.ts`, `apps/api/src/routes/v1/share-links.integration.test.ts`, `apps/api/src/routes/shared.integration.test.ts`
- Create: `apps/worker/src/handlers/share-cleanup.ts`, `apps/worker/src/handlers/share-cleanup.test.ts`
- Modify: `apps/worker/src/registry.ts` (sequential static-handler handoff)

**Interfaces:**

- Produces `ShareLinkService.create(actorId, noteId, input, idempotencyKey)`, `revoke(actorId, linkId)`, and `resolve(token)`; `resolve` returns a read-only projection, never a mutation-capable service.
- Public route is `GET /api/v1/shared/:token`; management routes are `POST /api/v1/notes/:noteId/share-links` and `DELETE /api/v1/share-links/:id`.
- Share creation persists an encrypted idempotency response keyed by workspace/actor/operation/key; an identical replay returns the original link once, while a different request hash returns `OPERATION_REUSED` without minting another token.

- [ ] **Step 1: Write RED security tests.** Assert CSPRNG token entropy/length, database stores only a hash, sequential ids do not resolve, cross-workspace management is denied, anonymous reads are read-only, expiry/revocation is checked on every request, malformed/oversized tokens fail uniformly, and plaintext tokens never appear in logs.

- [ ] **Step 2: Run RED.**

Run: `pnpm --filter @glyphquire/api test:integration -- src/routes/v1/share-links.integration.test.ts` and `pnpm --filter @glyphquire/api test:integration -- src/routes/shared.integration.test.ts`

Expected: FAIL because the schema, service, routes, and cleanup handler do not exist.

- [ ] **Step 3: Add schema/service/routes.** Generate at least 32 random bytes, hash with a server-side domain-separated SHA-256/HMAC strategy, store scope/creator/expiry/revoked_at, and compare hashes in constant-time. Recheck note deletion and workspace membership state at resolution; return a stable 404 for invalid, expired, revoked, or inaccessible links. Mount the anonymous route before the generic `/api/v1/*` request-context and personal-workspace middleware, while retaining security headers, client-IP extraction, and rate limiting; it must never receive authenticated mutation services.

- [ ] **Step 4: Add cleanup job.** Expired links are soft-invalid immediately and physically removed by `share.cleanup {workspaceId,scope:"expired",batchSize:1..100,cursor?}` only after `SHARE_DELETE_GRACE_SECONDS=3600`; targeted revocation uses `{workspaceId,scope:"one",shareLinkId}`. The Task 7 scheduler emits the expired scan hourly, each continuation carries the next deterministic cursor, and tests cover before/at/after-expiry and before/at/after-grace boundaries. Revocation is synchronous and never waits for cleanup; cleanup is idempotent and only deletes rows already expired or revoked after rechecking the grace timestamp.

- [ ] **Step 5: Run GREEN and commit.**

Run: `pnpm --filter @glyphquire/database test -- src/migrations/phase5-share-links.integration.test.ts` (fresh `0000`–`0009`, exact `0004_phase3_themes` upgrade, rerun, transactional rollback preserving notes, journal/hash integrity, runtime-role DDL/journal denial); real PostgreSQL integration, anonymous public-route tests, log-scrub assertions, worker cleanup tests, `pnpm typecheck`, `pnpm lint`.

```bash
git add packages/database apps/api/src/modules/share-links apps/api/src/routes/v1/share-links.ts apps/api/src/routes/shared.ts apps/api/src/routes/v1/share-links.integration.test.ts apps/api/src/routes/shared.integration.test.ts apps/worker/src/handlers/share-cleanup.ts apps/worker/src/handlers/share-cleanup.test.ts apps/worker/src/registry.ts
git commit -m "feat: add revocable read-only share links"
```

---

### Task 7: Lifecycle, P1 Maintenance, and Operational Controls

**Files:**

- Create: `packages/database/src/schema/{workspace-deletions,account-deletions}.ts`, `packages/database/src/migrations/0010_phase5_lifecycle.sql`, `packages/database/src/migrations/meta/0010_snapshot.json`, `packages/database/src/migrations/phase5-lifecycle.integration.test.ts`
- Create: `apps/api/src/modules/lifecycle/{WorkspaceDeletionService,AccountDeletionService,WorkspaceDeletionService.integration.test,AccountDeletionService.integration.test}.ts`, `apps/api/src/routes/v1/deletion.ts`, `apps/api/src/routes/v1/deletion.integration.test.ts`
- Create: `apps/worker/src/handlers/{workspace-search-rebuild,workspace-purge,account-purge,export-expiry,asset-orphan-cleanup,version-retention,idempotency-cleanup,backup-verification}.ts`
- Create: `apps/worker/src/handlers/maintenance.test.ts`
- Create: `apps/worker/src/scheduler.ts`, `apps/worker/src/scheduler.test.ts`
- Create: `infra/backup/phase5-backup.sh`, `infra/backup/phase5-backup.service`, `infra/backup/phase5-backup.timer`, `infra/backup/phase5-pre-destructive-hook.sh`, `infra/backup/phase5-restore-drill.sh`, `tests/integration/phase5-backup-schedule.test.ts`, `tests/integration/phase5-restore-drill.test.ts`, `docs/evidence/phase5/backup-restore-drill.md`
- Create: `packages/api-contract/src/maintenance/{schemas,types}.ts`, `packages/api-contract/src/maintenance-contracts.test.ts`
- Modify: `apps/api/src/routes/v1/search.ts`, `apps/api/src/modules/search/SearchService.ts` (sequential handoff from Task 3)
- Create: `apps/api/src/routes/v1/maintenance.ts`, `apps/api/src/routes/v1/maintenance.integration.test.ts`
- Modify: `apps/worker/src/registry.ts` (extend `search.rebuild` to workspace scope and register all remaining handlers; preserve P0 activation and P1 diagnostic gates), `packages/api-contract/src/index.ts` (export maintenance and deletion contracts), `packages/database/src/schema/index.ts`, `packages/database/src/index.ts`, and migration metadata through the generated workflow
- Modify: `docker-compose.yml`
- Modify: `docs/deployment/phase5-worker-runbook.md`, create `docs/deployment/phase5-lifecycle-runbook.md`

**Interfaces:**

- Produces operator-only bounded workspace rebuild with an explicit `workspaceId`, batch size, and idempotency key; it reuses Task 3's `OperatorAuthorizer`, cannot be invoked by a normal member, and fails closed if the configured allowlist is absent.
- Produces metrics/log events for job claimed/completed/retried/DLQ, search freshness, asset quota, export duration, and share revocation, with bounded cursor progress and no content/token labels. The scheduler emits `import.cleanup {workspaceId,scope:"staging"}` and due `workspace.purge`/`account.purge` jobs at least every 15 minutes; `share.cleanup {workspaceId,scope:"expired"}`, `export.expire`, `asset.orphan_cleanup`, and `idempotency.cleanup` at least hourly; and `version.retention` daily. Each continuation is one bounded job.
- Produces `GET /api/v1/maintenance/capabilities`, returning `{ operator: boolean; capabilities: string[] }` after the same fail-closed allowlist check; denied users receive no operation names beyond the stable authorization error.
- Produces `POST /api/v1/maintenance/search-rebuild`, `GET /api/v1/maintenance/dead-letters`, `POST /api/v1/maintenance/dead-letters/:id/replay`, `POST /api/v1/maintenance/asset-cleanup`, and `GET /api/v1/maintenance/backup-verification`; each requires the operator authorizer, bounded input, request id, and idempotency key for mutations.
- Produces owner-only `POST /api/v1/workspaces/:workspaceId/deletion` accepting exactly `{ confirm: "DELETE_WORKSPACE" }` plus `Idempotency-Key`; it creates a `workspace_deletions` record and a delayed `workspace.purge` job. Produces authenticated `POST /api/v1/account/deletion` accepting the same exact confirmation and idempotency contract; it creates an `account_deletions` coordinator, enumerates the actor's workspaces server-side, and schedules one workspace purge per workspace followed by `account.purge` only after all workspace purges report completion. `WORKSPACE_PURGE_GRACE_SECONDS=86400` is the minimum delay, and both purge handlers recheck authorization, confirmation, live references, and deletion state before transactionally removing primary records, versions, assets, search records, share links, pending jobs, and account sessions. Partial object deletion is resumable and never exposes object keys or note content.
- Produces a documented daily encrypted PostgreSQL/object-storage backup scheduled by the checked-in systemd timer (or an equivalent deployment scheduler), a pre-destructive-migration backup hook, 30-day retention enforced by the backup script, and a monthly restore drill that verifies note/revision/asset relationships and content hashes. Backup failure exits non-zero, emits a scrubbed `BACKUP_FAILED` event consumed by the deployment alert rule within five minutes, and remains visible to `backup.verify`; drill evidence is append-only and contains no document bodies or credentials. These backup and deletion guarantees are P0 release requirements, not optional maintenance.
- `workspace_deletions` stores `{ id, workspaceId, requestedBy (opaque auth text), confirmedAt, executeAfter, status: pending|processing|completed|failed, idempotencyKey, manifest, sanitizedError }` with one active deletion per workspace; its workspace and requester FKs use `ON DELETE SET NULL` so the completed manifest survives both the final workspace delete and account purge. `account_deletions` stores `{ id, accountId (opaque auth text), confirmedAt, executeAfter, status, workspaceIds, manifest, sanitizedError }` without a cascading user FK, so the coordinator remains auditable through account removal. `workspace.purge` carries `{ workspaceId, deletionId }`; `account.purge` carries `{ workspaceId: UUID | null, accountDeletionId, accountId }`; both are registered before P0 activation.

- [ ] **Step 1: Write RED maintenance tests.** Assert strict shared maintenance/deletion request/response schemas, capabilities and every maintenance endpoint are operator-only and bounded, staging-import scans run every 15 minutes, expired exports cannot download, orphan cleanup does not delete live references before `ASSET_DELETE_GRACE_DAYS`, exactly-at-grace deletion records the job id, version retention keeps all versions for active notes and deletes versions only for soft-deleted notes whose `deletedAt` is at least `VERSION_RETENTION_DAYS=30` old, idempotency cleanup retains rows newer than `IDEMPOTENCY_RETENTION_DAYS=30` and all in-progress leases, backup verification failures are visible, pre-destructive backup failure blocks migration/purge, workspace and account confirmation/deletion honor their 24-hour grace and remove all scoped primary records, dependent records, jobs, and sessions within `DELETION_DEADLINE_DAYS=30`, and every maintenance job is idempotent. Include a crash/retry test while deleting the final workspace, a zero-workspace account purge, an account with multiple workspaces to prove the lifecycle job remains acknowledgeable after FK nulling, and a failed-purge re-enqueue/alert test through the 30-day deadline boundary. For share, version, and idempotency scans, cover before/at/after cutoff, exactly full batches, continuation cursors, and empty-tail behavior. Inject a clock so no test waits in real time.

- [ ] **Step 2: Run RED.**

Run: `pnpm --filter @glyphquire/api test:integration -- src/routes/v1/maintenance.integration.test.ts` and `pnpm --filter @glyphquire/worker test -- src/handlers/maintenance.test.ts` and `pnpm --filter @glyphquire/api-contract test -- src/maintenance-contracts.test.ts`

Expected: FAIL because maintenance handlers/routes/metrics are absent.

- [ ] **Step 3: Implement bounded handlers and operator authorization.** Every scan uses a stable `(createdAt,id)` cursor, the typed `batchSize` maximum of 100, and returns `nextCursor: null` only when fewer than `batchSize` rows remain; otherwise it schedules one continuation job with the next cursor. No handler accepts arbitrary SQL or object keys. `export.expire` and `asset.orphan_cleanup` require their exact expiry/grace predicates plus a live-reference recheck. `share.cleanup` uses `(revoked_at IS NOT NULL AND revoked_at <= now - SHARE_DELETE_GRACE_SECONDS) OR (revoked_at IS NULL AND expires_at <= now - SHARE_DELETE_GRACE_SECONDS)`; revocation remains immediately effective while physical deletion waits for that grace. `version.retention` applies the exact eligibility predicate `note.deletedAt IS NOT NULL AND note.deletedAt <= now - VERSION_RETENTION_DAYS`; active-note versions are never removed in Phase 5. Eligible version rows are deleted in deterministic batches after a live-note/restore-reference check, with a job id recorded in audit metadata. `idempotency.cleanup` deletes only completed records satisfying `completed_at IS NOT NULL AND completed_at <= now - IDEMPOTENCY_RETENTION_DAYS`; it never removes in-progress leases or records with a null completion time. `workspace.purge` rechecks `executeAfter`, deletes every other workspace-scoped job and workspace-owned row first while retaining its own `workspace_deletions` and lifecycle job rows, then deletes workspace database rows in one transaction; the deletion record and current job's `workspace_id` are set NULL by their FKs, and the handler records terminal completion afterward. `account.purge` runs only after every workspace in its coordinator is complete (or immediately for a zero-workspace account), then removes the account's sessions, identity rows, and unrelated pending-job/idempotency metadata in one transaction while retaining its own `account_deletions` coordinator and lifecycle job until terminal acknowledgement; its nullable routing scope remains durable. Backup verification reports a scrubbed failure and remains retry/DLQ visible.

- [ ] **Step 4: Add production configuration and runbook.** Document `S3_*`, `BACKUP_ENCRYPTION_KEY`, worker polling/attempt limits, DLQ inspection/replay, search rebuild, migration, workspace/account deletion, backup/restore, alerting, and incident rollback. The scheduler emits `import.cleanup` every 15 minutes; `share.cleanup`, `export.expire`, `asset.orphan_cleanup`, and `idempotency.cleanup` hourly; `version.retention` daily; and due `workspace.purge`/`account.purge` jobs every 15 minutes. Failed or stranded purge coordinators are re-enqueued and alerted on each scan until completion or `DELETION_DEADLINE_DAYS=30`; a deadline breach is a release-blocking incident. `assertRegistryComplete(registry, P0_JOB_TYPES)` is required at worker activation and fails closed on any missing P0 handler; `assertPhase5Complete(registry)` reports optional P1 gaps without blocking the first release. `phase5-backup.timer` invokes `phase5-backup.sh` daily; the script encrypts database/object snapshots, enforces the 30-day retention cutoff, and emits a scrubbed failure event/alert on any error. `phase5-pre-destructive-hook.sh` must succeed before migration or purge operations. `phase5-restore-drill.sh` restores into an isolated database/bucket and runs the relationship/hash assertions, retaining append-only evidence. Compose starts MinIO and the worker only after database/storage preflight succeeds.

The account-purge transaction excludes its currently claimed lifecycle job from the pending-job delete set, then marks that row completed after the account and deletion coordinator commit; a crash before acknowledgement leaves the durable nullable-scope job eligible for retry.

- [ ] **Step 5: Run GREEN and commit.**

Run: worker maintenance tests; real PostgreSQL/MinIO lifecycle integration; fresh migrations `0000`–`0010`; exact `0004_phase3_themes` upgrade and idempotent rerun; rollback preserving pre-existing rows; migration journal/hash verification; runtime-role DDL/journal/sequence denial; workspace/account deletion and backup/restore drill; `pnpm typecheck`; `pnpm lint`; `pnpm build`; `git diff --check`.

```bash
git add packages/api-contract/src/maintenance packages/api-contract/src/index.ts packages/database/src/schema/workspace-deletions.ts packages/database/src/schema/account-deletions.ts packages/database/src/migrations/0010_phase5_lifecycle.sql packages/database/src/migrations/meta/0010_snapshot.json packages/database/src/migrations/meta/_journal.json packages/database/src/migrations/phase5-lifecycle.integration.test.ts packages/database/src/schema/index.ts packages/database/src/index.ts apps/api/src/modules/lifecycle apps/api/src/routes/v1/deletion.ts apps/api/src/routes/v1/deletion.integration.test.ts apps/api/src/routes/v1/maintenance.ts apps/api/src/routes/v1/maintenance.integration.test.ts apps/api/src/routes/v1/search.ts apps/api/src/modules/search/SearchService.ts apps/worker/src/handlers/workspace-search-rebuild.ts apps/worker/src/handlers/workspace-purge.ts apps/worker/src/handlers/account-purge.ts apps/worker/src/handlers/export-expiry.ts apps/worker/src/handlers/asset-orphan-cleanup.ts apps/worker/src/handlers/version-retention.ts apps/worker/src/handlers/idempotency-cleanup.ts apps/worker/src/handlers/backup-verification.ts apps/worker/src/handlers/maintenance.test.ts apps/worker/src/scheduler.ts apps/worker/src/scheduler.test.ts apps/worker/src/registry.ts infra/backup/phase5-backup.sh infra/backup/phase5-backup.service infra/backup/phase5-backup.timer infra/backup/phase5-pre-destructive-hook.sh infra/backup/phase5-restore-drill.sh tests/integration/phase5-backup-schedule.test.ts tests/integration/phase5-restore-drill.test.ts docs/evidence/phase5/backup-restore-drill.md docker-compose.yml docs/deployment/phase5-worker-runbook.md docs/deployment/phase5-lifecycle-runbook.md
git commit -m "feat: add phase5 lifecycle maintenance"
```

---

## Execution Stop Controls

Stop the current slice before committing if any of these occur: migration catalog/hash drift, an upgrade from `0004_phase3_themes` changes existing rows or bytes, authorization or log-scrub tests fail, object/metadata compensation leaves an orphan, a required dependency cannot initialize, a worker retry exceeds its bounded policy, or a required test is skipped without an explicit reason. Record the exact command and failure in the slice report, fix the issue, and rerun the complete slice gate before resuming. Do not activate a route or worker consumer while its migration, contract, or security seam is red.

---

### Task 8: Web Integration and Full Phase 5 Acceptance

**Files:**

- Create: `apps/web/src/api/Phase5Client.ts`, `apps/web/src/api/Phase5Client.test.ts`
- Create: `apps/web/src/components/assets/AssetManager.vue`, `apps/web/src/components/search/SearchPalette.vue`, `apps/web/src/components/transfer/TransferDialog.vue`, `apps/web/src/components/share/ShareLinkDialog.vue`
- Create: `apps/web/src/stores/phase5.ts`, `apps/web/src/stores/phase5.test.ts`
- Create: `apps/web/src/components/assets/AssetManager.test.ts`, `apps/web/src/components/search/SearchPalette.test.ts`, `apps/web/src/components/transfer/TransferDialog.test.ts`, `apps/web/src/components/share/ShareLinkDialog.test.ts`
- Modify: `apps/web/src/editors/visual/schema.ts`, `apps/web/src/editors/visual/MilkdownVisualAdapter.ts`; create `apps/web/src/editors/visual/asset-resolver.ts`, `apps/web/src/editors/visual/asset-resolver.test.ts`
- Modify: `apps/web/src/components/workbench/Workbench.vue`, `apps/web/src/components/workbench/CommandPalette.vue`, `apps/web/src/router/index.ts`
- Modify: `apps/api/src/env.ts` to expose the validated Phase 5 storage/origin/alert configuration to final route wiring
- Create: `tests/e2e/phase5.spec.ts`, `apps/api/src/phase5-acceptance.integration.test.ts`
- Create: `apps/api/src/search-freshness.integration.test.ts` (five-user workload and 60-second P0 bound)
- Create: `tests/load/phase5-product-services.ts` (reproducible 30-minute, five-user §40.3 workload), `tests/integration/phase5-alerting.test.ts`
- Modify: `package.json` to expose `pnpm test:load:phase5` with deterministic duration/user parameters
- Modify: `apps/api/src/app.ts` only for final route/port wiring; mount `/api/v1/shared/*` before generic `/api/v1/*` request-context/personal-workspace middleware while retaining public-route security/rate limits. Browser upload/download uses native `FormData`/`Blob`, so `apps/web/package.json` requires no new dependency
- Create/update: `docs/deployment/phase5-release-runbook.md`, `docs/evidence/phase5/{README,security-compliance-matrix,performance-load,alert-delivery,browser-accessibility}.md`, `tests/e2e/phase5-accessibility.spec.ts`

**Interfaces:**

- `Phase5Client` consumes the shared contracts and exposes `uploadAsset`, `search`, `startImport`, `getImport`, `startExport`, `getExport`, `createShareLink`, and `revokeShareLink`; every method validates both request and response and maps network failures to stable public errors.
- `asset-resolver.ts` accepts only canonical `asset://<uuid>` references, resolves them through the authenticated same-origin API for the active workspace, rejects arbitrary schemes/cross-workspace identifiers, and never places a raw `asset:` URL or remote SVG markup in the DOM. `schema.ts` and `MilkdownVisualAdapter.ts` use this resolver as the sole image source seam.
- Workbench UI displays search results, asset references, import/export status, and share-link state without trusting HTML/Markdown or rendering remote SVG inline.

- [ ] **Step 1: Write RED contract/component tests.** Assert invalid request/response data is rejected, unauthorized/expired errors are rendered without provider details, pending export/import survives reload through status polling, asset references remain logical `asset://<uuid>`, and revoked links disappear from the UI.

- [ ] **Step 2: Run RED.**

Run: `pnpm --filter @glyphquire/web test -- src/api/Phase5Client.test.ts` and the new component tests.

Expected: FAIL because the client, stores, and components do not exist.

- [ ] **Step 3: Implement the client and UI.** Use root-relative same-origin API requests, shared Zod parsing, request ids, and `Idempotency-Key`; show bounded progress/error states and poll both import and export status after reload. Keep visual editor content inert; route every `asset://<uuid>` through the owned resolver/schema seam, rejecting arbitrary schemes, cross-workspace IDs, and inline/remote SVG.

- [ ] **Step 4: Add acceptance E2E and freshness load.** With PostgreSQL, MinIO, API, worker, and web running, drive Chrome through upload → note reference → search → export/download → create anonymous share → revoke → verify 404. Include permission denial, retry, stale search revision, archive traversal, and no-secret/no-content log assertions. In `search-freshness.integration.test.ts`, run five concurrent workspace actors through committed mutations and assert every search result appears within 60 seconds with no dead-lettered index job.

- [ ] **Step 5: Run full release gates.**

Run: `pnpm typecheck`; `pnpm lint`; `pnpm format:check`; `pnpm build`; `pnpm -r test`; `pnpm test:cross-package`; `pnpm test:integration`; `CI=1 pnpm test:e2e` with the existing Chrome; `pnpm exec playwright test tests/e2e/phase5-accessibility.spec.ts`; fresh/upgrade from exact `0004_phase3_themes`/rerun migration suites; five-user search-freshness test; `pnpm test:load:phase5 -- --duration=30m --users=5` (record p95 and error budgets); `pnpm test:integration -- phase5-alerting.test.ts`; frozen offline install; and `git diff --check`.

Expected: all P0 acceptance cases, including the five-user/60-second freshness test, the reproducible 30-minute workload, alert delivery within five minutes, the security compliance matrix (including the now-applicable file-upload controls), and keyboard/axe/browser-accessibility evidence, pass; no P0 test may be skipped and no README-related assertion is added. Existing Chrome is the local execution browser; the evidence artifact records the latest two stable Chrome/Firefox/Safari/Edge matrix supplied by release CI or manual verification, plus VoiceOver/NVDA smoke results.

- [ ] **Step 6: Publish evidence and commit.** Record command outputs, migration hashes, worker/DLQ behavior, security references, compliance applicability/evidence/exceptions, five-user 30-minute load results, alert notification timestamps, browser/accessibility results, and known P1 boundaries in the Phase 5 evidence files. A missing external browser or screen-reader result is a documented release blocker, not a silently skipped test.

```bash
git add package.json apps/api/src/app.ts apps/api/src/env.ts apps/api/src/phase5-acceptance.integration.test.ts apps/api/src/search-freshness.integration.test.ts apps/web/src/api/Phase5Client.ts apps/web/src/api/Phase5Client.test.ts apps/web/src/components/assets apps/web/src/components/search apps/web/src/components/transfer apps/web/src/components/share apps/web/src/components/workbench/Workbench.vue apps/web/src/components/workbench/CommandPalette.vue apps/web/src/stores/phase5.ts apps/web/src/stores/phase5.test.ts apps/web/src/editors/visual/schema.ts apps/web/src/editors/visual/MilkdownVisualAdapter.ts apps/web/src/editors/visual/asset-resolver.ts apps/web/src/editors/visual/asset-resolver.test.ts apps/web/src/router/index.ts tests/e2e/phase5.spec.ts tests/e2e/phase5-accessibility.spec.ts tests/load/phase5-product-services.ts tests/integration/phase5-alerting.test.ts docs/deployment/phase5-release-runbook.md docs/evidence/phase5
git commit -m "feat: complete phase5 p0 web acceptance"
```

---

### Task 9: P1 Advanced Search Ranking

**Files:**

- Create: `packages/search/src/ranking.ts`, `packages/search/tests/ranking.test.ts`, `apps/api/src/modules/search/ranking.integration.test.ts`
- Modify: `packages/api-contract/src/search/{schemas,types}.ts` and `apps/api/src/modules/search/SearchService.ts` as sequential handoffs from Tasks 1 and 7

**Interfaces:**

- Adds `ranking: "weighted-v1" | "relevance"` to the bounded search query (default `relevance`) and returns `rankingVersion` in each result. `weighted-v1` scores title 8, tags 6, headings 4, and body 1, then ties by `updatedAt DESC, noteId ASC`; it never changes tenant/deletion filters.

- [ ] **Step 1: Write RED ranking tests.** Assert deterministic weighted scores, CJK/trigram fallback, exact tie ordering, invalid ranking rejection, and unchanged authorization/deleted-note filtering.
- [ ] **Step 2: Run RED.** Run `pnpm --filter @glyphquire/search test -- tests/ranking.test.ts` and `pnpm --filter @glyphquire/api test:integration -- src/modules/search/ranking.integration.test.ts`; expect missing ranking schema/implementation failures.
- [ ] **Step 3: Implement and verify.** Add the pure scorer, contract field, and service query selection without changing persisted canonical Markdown or search indexes; run both tests plus `pnpm typecheck` and `pnpm lint`.
- [ ] **Step 4: Commit.**

```bash
git add packages/search/src/ranking.ts packages/search/tests/ranking.test.ts apps/api/src/modules/search/ranking.integration.test.ts packages/api-contract/src/search apps/api/src/modules/search/SearchService.ts
git commit -m "feat: add deterministic search ranking"
```

### Task 10: P1 Additional Export Formats

**Files:**

- Create: `apps/api/src/modules/transfer/formatters/{plain-text,ast-json}.ts`, `apps/api/src/modules/transfer/formatters/formatters.test.ts`, `apps/worker/src/handlers/export-formats.test.ts`
- Modify: `packages/api-contract/src/transfer/{schemas,types}.ts`, `apps/api/src/modules/transfer/ExportService.ts`, `apps/worker/src/handlers/export.ts`, and `apps/web/src/components/transfer/TransferDialog.vue` as sequential handoffs

**Interfaces:**

- Extends the format union with `plain-text` and `ast-json` (canonical AST JSON with schema version); existing Markdown, ZIP, and HTML output remains byte-compatible. Both formats use the same export idempotency/status/download contract and never embed provider credentials or executable HTML.

- [ ] **Step 1: Write RED formatter tests.** Assert stable plain-text normalization, schema-versioned AST JSON, unsupported-node preservation, deterministic bytes, unauthorized download denial, expiry, and idempotent repeat.
- [ ] **Step 2: Run RED.** Run `pnpm --filter @glyphquire/api test -- src/modules/transfer/formatters/formatters.test.ts` and `pnpm --filter @glyphquire/worker test -- src/handlers/export-formats.test.ts`; expect missing formatter failures.
- [ ] **Step 3: Implement and verify.** Add pure formatters, route validation, worker selection from the static format map, UI format choices, and shared response validation; run focused tests, `pnpm typecheck`, `pnpm build`, and `pnpm test:cross-package`.
- [ ] **Step 4: Commit.**

```bash
git add packages/api-contract/src/transfer apps/api/src/modules/transfer/ExportService.ts apps/api/src/modules/transfer/formatters apps/worker/src/handlers/export.ts apps/worker/src/handlers/export-formats.test.ts apps/web/src/components/transfer/TransferDialog.vue
git commit -m "feat: add phase5 export formats"
```

### Task 11: P1 Administrative Maintenance UI

**Files:**

- Create: `apps/web/src/components/admin/Phase5MaintenancePanel.vue`, `apps/web/src/components/admin/Phase5MaintenancePanel.test.ts`
- Modify: `apps/web/src/api/Phase5Client.ts`, `apps/web/src/api/Phase5Client.test.ts`, `apps/web/src/components/workbench/CommandPalette.vue`

**Interfaces:**

- Adds `getMaintenanceCapabilities`, `startSearchRebuild`, `listDeadLetters`, `replayDeadLetter`, `runAssetCleanup`, and `getBackupVerification` client methods. The panel renders only when the server-authorized operator capability is returned; a normal member sees no controls and receives the same sanitized denial envelope.

- [ ] **Step 1: Write RED UI tests.** Assert hidden controls for members, operator-only bounded parameters, sanitized failures, progress polling, and no document/token content in rendered labels or logs.
- [ ] **Step 2: Run RED.** Run `pnpm --filter @glyphquire/web test -- src/components/admin/Phase5MaintenancePanel.test.ts`; expect missing component/client methods.
- [ ] **Step 3: Implement and verify.** Wire the panel to Task 7 endpoints with root-relative requests, shared schemas, request ids, and bounded cursor controls; run focused tests, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `CI=1 pnpm test:e2e` with the operator fixture.
- [ ] **Step 4: Commit.**

```bash
git add apps/web/src/components/admin/Phase5MaintenancePanel.vue apps/web/src/components/admin/Phase5MaintenancePanel.test.ts apps/web/src/api/Phase5Client.ts apps/web/src/api/Phase5Client.test.ts apps/web/src/components/workbench/CommandPalette.vue
git commit -m "feat: add phase5 maintenance controls"
```

---

## Final Acceptance Checklist

- [ ] P0: authorized asset upload/download/delete with actual MIME/size/hash checks and delayed cleanup.
- [ ] P0: search results are tenant-safe, deleted-filtered, deterministic, and visible within 60 seconds under the five-user ceiling.
- [ ] P0: Markdown/ZIP import and Markdown/ZIP/HTML export are bounded, idempotent, CAS-safe, and durable.
- [ ] P0: share links are opaque, hashed, read-only, expiry-aware, and immediately revocable.
- [ ] P0: generic jobs are transactional, at-least-once, idempotent, retry-bounded, and DLQ-observable.
- [ ] P0: authorization, error mapping, request ids, and log scrubbing are verified at API and worker boundaries.
- [ ] P0: encrypted daily PostgreSQL/object-storage backups, 30-day retention, pre-destructive backup, monthly restore evidence, and 24-hour RPO are verified; confirmed account/workspace deletion removes primary records, versions, assets, search records, share links, pending jobs, and sessions within 30 days.
- [ ] P1: bulk workspace rebuild, thumbnails/metadata enrichment, orphan automation, advanced ranking, extra formats, and administrative maintenance controls are implemented and verified by Tasks 2, 4, and 7–11; the P0 operator rebuild remains the bounded one-note path delivered in Task 3.
- [ ] Existing Phase 0–4 migration bytes, note/version behavior, README, and README tests remain untouched.
