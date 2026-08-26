# Phase 5 — Product Services Design Spec

**Status:** Design sections approved in conversation; implementation pending written-spec and plan approval.

**Goal:** Complete the product-service layer for assets, full-text search, import/export, share links, and durable background jobs while preserving the existing note/version-history contracts. This is a production-oriented Phase 5, not a reduced MVP. Availability and horizontal scale are explicitly out of scope; the expected deployment has at most five concurrent users.

**References:** `docs/SPEC.md` §§20–24, 27, 33, 43–44, 49; `docs/MARKDOWN_SPEC.md`; existing Phase 2–4 migration, auth, editor, runtime, and document-engine contracts.

## 1. Architecture and Delivery Order

Phase 5 uses shared contracts followed by sequential vertical slices:

1. **Shared contracts and job envelope** — versioned API schemas, cursor/idempotency conventions, generic `JobEnvelope`, error codes, and worker ports.
2. **Assets and storage** — metadata migration, object-storage port plus MinIO adapter, upload/download/delete APIs, and one metadata/thumbnail job path.
3. **Search and worker** — searchable-document migration and indexes, Markdown-to-search-text extraction, revision-aware indexing/removal handlers, worker runtime, search API, and rebuild operations.
4. **Import/export** — bounded Markdown/ZIP ingestion, asset remapping, export records and downloads, and asynchronous export jobs.
5. **Share links and lifecycle** — opaque token links, read-only access/revocation, cleanup jobs, retention/orphan handling, and final cross-service integration.

Each slice owns its migration, API contract, authorization, scrubbed errors/logging, tests, and runbook updates. Existing `document_jobs` remains the strongly typed note-mutation outbox; the new generic `jobs` table is not a replacement for its foreign-key and CAS guarantees.

## 2. Data Model and Contracts

All identifiers are UUIDs, all workspace scope is server-derived, and soft deletion follows existing database conventions.

### 2.1 Tables

- **`assets`**: `id`, `workspace_id`, `owner_id`, `object_key`, `original_name`, `mime_type`, `size`, `sha256`, timestamps, and `deleted_at`. The server alone creates keys as `workspace/{workspaceId}/assets/{assetId}/original`.
- **`search_documents`**: one row per note with indexed revision, title, headings, body, tags, normalized text, and PostgreSQL `tsvector`; `pg_trgm` supports CJK/fuzzy matching.
- **`exports`**: requester/scope, format, status, idempotency key, object key, expiry, and sanitized failure summary.
- **`share_links`**: note/workspace scope, token hash, creator, expiry, and `revoked_at`; the plaintext token is never persisted.
- **`jobs`**: versioned type/payload, attempts, lock timestamps, next-attempt time, status, error summary, and DLQ state. Payloads are schema-validated before dispatch.

### 2.2 Shared interfaces

`packages/api-contract` is the only public source for request/response schemas. Lists and searches use deterministic cursors and bounded page sizes. Retryable creates, uploads, imports, and exports require `Idempotency-Key`. Mutations use CAS or equivalent conditional requests.

The storage boundary is a server-side `ObjectStoragePort` with `put`, `get`, `delete`, and `createDownloadUrl`; the existing stub is adapted without exposing provider-specific types. The search boundary follows the SPEC contract:

```ts
interface SearchPort {
  indexNote(note: SearchableNote): Promise<void>;
  removeNote(noteId: string): Promise<void>;
  search(query: SearchQuery): Promise<SearchResult[]>;
}
```

Every job is a `JobEnvelope` containing `{ id, type, version, attempts, createdAt, payload }`. Handlers are idempotent and must reject stale note revisions.

## 3. API and Data Flows

### 3.1 Assets

- `POST /api/v1/workspaces/:workspaceId/assets` accepts bounded multipart/streaming input. The API verifies membership, declared and actual byte size, SHA-256, MIME allowlist, normalized filename, and quota before committing metadata and object data.
- `GET /api/v1/assets/:assetId` returns authorized metadata. A download endpoint verifies scope first and then returns a short-lived URL or server-streamed content. SVG is never served as inline active content.
- `DELETE /api/v1/assets/:assetId` soft-deletes metadata and queues delayed object cleanup. Retries with the same idempotency key are safe.

### 3.2 Search

Note writes enqueue `search.index` or `search.remove` in the same transaction as the mutation. `GET /api/v1/search?workspaceId=...&q=...&cursor=...&pageSize=...` enforces membership, deleted filtering, deterministic ordering, and a target freshness of 60 seconds. An operator-only endpoint supports bounded one-note rebuild in P0; bulk workspace rebuild is a P1 operation. Ordinary users cannot trigger unbounded work.

### 3.3 Import and export

- `POST /api/v1/workspaces/:workspaceId/import` accepts Markdown or ZIP and returns an import job id.
- `POST /api/v1/workspaces/:workspaceId/export` and `POST /api/v1/notes/:noteId/export` create `exports` rows and jobs.
- `GET /api/v1/exports/:id` reports status; `GET /api/v1/exports/:id/download` streams the completed artifact.

ZIP processing rejects traversal, symlinks, excessive file count/expanded size, malformed archives, and unsupported references. Existing-note imports require `baseRevision`; conflicts never overwrite server content. Exports include canonical Markdown, referenced assets, and metadata; rendered HTML is an additional format.

### 3.4 Share links

- `POST /api/v1/notes/:noteId/share-links` and `DELETE /api/v1/share-links/:id` require membership.
- `GET /api/v1/shared/:token` is anonymous, read-only, and rechecks hash, expiry, and revocation on every request.

Tokens come from a CSPRNG and are stored only as hashes. Sequential identifiers, note ids, and provider errors never act as secrets.

## 4. Security and Failure Handling

Authorization is evaluated on the server from the authenticated principal and current workspace membership; client-supplied workspace, owner, role, object key, revision, or visibility fields are advisory only. Request ids, error codes, and structured logs are retained, but Markdown, tokens, cookies, raw provider errors, SQL, and stack traces are scrubbed.

Workers provide at-least-once delivery with bounded exponential backoff, idempotent handlers, explicit stale-revision checks, and a durable DLQ. Startup fails closed when required storage/search/database dependencies are unavailable. Cleanup is soft-delete first and irreversible deletion is delayed and auditable.

Implementation references for security review include OWASP File Upload Cheat Sheet, OWASP ASVS (authentication/access control/logging), PostgreSQL privilege and RLS guidance, ZIP path-traversal defenses, and provider-specific MinIO/R2 security guidance. These are references for implementation and tests, not runtime dependencies.

## 5. Testing, Deployment, and Acceptance

Each slice must pass unit/schema tests, API and contract tests, real PostgreSQL/MinIO integration, migration fresh/upgrade/rerun checks, least-privilege checks, rollback/transaction tests, and security abuse cases. Worker suites cover duplicate delivery, restart, retry exhaustion, DLQ, and stale revisions. Chrome Playwright E2E covers upload → reference → search → export → share → revoke; it uses the existing local Chrome and does not assert README text.

Deployment is ordered: forward-compatible schema and bucket policy, then API contracts/handlers, then worker consumers and feature flags. Migrations are forward-only and journal/hash verified; failure stops feature activation rather than deleting tables. The runbook documents environment variables, migration and worker commands, DLQ/rebuild operations, backup/restore, and incident rollback.

**P0 (release required):** asset upload/download/delete; search visible within 60 seconds; Markdown/ZIP import; Markdown/ZIP/HTML export; read-only share links with immediate revoke; generic retry/DLQ; complete authorization and scrubbed audit logs.

**P1 (same Phase, schedulable after P0):** thumbnail/metadata enrichment, full workspace index rebuild, advanced ranking, retention/orphan cleanup automation, extra export formats, and administrative UI.

Release acceptance requires green root typecheck/lint/format/build/test, package integrations, cross-package contracts, Chrome E2E, fresh and upgraded migrations, no secrets or note contents in logs, and a success/denial/retry/consistency case for every P0 feature.

## 6. Non-goals and Compatibility

High availability, multi-region storage, more than five simultaneous users, arbitrary plugin execution, and a new version-history model are not Phase 5 goals. Canonical Markdown remains the persisted source; existing version history, editor, runtime, auth, and `document_jobs` behavior must remain backward compatible.
