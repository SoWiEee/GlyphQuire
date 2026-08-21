# Phase 2 Editors Design

> Status: Approved in conversation
> Date: 2026-08-21

## Outcome

Phase 2 delivers a production-grade editing loop for the hosted GlyphQuire
application: minimal note management, CodeMirror Source Mode, Milkdown Visual
Mode, optional split view, transactional autosave, revision history, durable
local drafts, and explicit conflict recovery. It builds exclusively on the
Phase 1 document-engine contract for Markdown parsing, validation,
serialization, diagnostics, and round-trip preservation.

This phase includes backend PostgreSQL and `/api/v1` work. It is not a
frontend-only editor demo.

## Scope

Phase 2 includes:

- a VSCode-style workbench with Explorer, editor tab, command palette, mode
  controls, and status bar;
- CodeMirror 6 Source Mode and Milkdown Visual Mode;
- optional HackMD-style split view with one writable pane and one read-only
  projection;
- bidirectional support for every Phase 1 built-in block: `callout`, `sticky`,
  `tabs`, `columns`, `toggle`, `canvas`, and `p5`;
- note listing, creation, opening, rename, soft deletion, and restoration;
- version listing, manual checkpoints, version preview, and restore;
- transactional autosave with revision compare-and-swap and idempotent
  operations;
- IndexedDB draft persistence, offline retry, single-tab writing, and explicit
  `409` recovery;
- Chrome-based editor accessibility, E2E, conformance, and performance
  evidence.

The following remain outside Phase 2:

- Declarative Custom Blocks, themes, and the theme editor (Phase 3);
- executable `canvas` or `p5` runtime, sandbox host, and third-party code
  execution (Phase 4);
- folders, tags, sharing, search UI, and asset workflows (later product-service
  phases);
- CRDT, real-time collaboration, presence, and automatic three-way merge;
- complete Firefox, Safari, and Edge evidence. Phase 2 uses the currently
  available Chrome. Cross-browser P0-14 evidence is deferred to Production
  Hardening, so completing Phase 2 does not by itself satisfy P0-14.

## Architecture

The implementation uses contract-first vertical slices:

```text
VSCode-style Workbench
        |
        v
EditorSession -------- IndexedDB DraftStore
   |       |
   |       +-- CodeMirror SourceAdapter
   |       +-- Milkdown VisualAdapter
   |
   v
NoteClient / shared API schemas
   |
   v
NoteService ---- PostgreSQL transaction
   +-- authorization
   +-- document validation
   +-- revision CAS
   +-- note update
   +-- selective snapshot
   +-- durable search-job enqueue
```

`EditorSession` is the only browser-side editing authority. It owns Markdown,
the base revision, dirty state, diagnostics, save state, active mode, and
conflict state. CodeMirror and Milkdown are adapters. At most one adapter is
writable at a time; the split pane is always read-only.

`NoteService` owns the complete persistence transaction. Routes do not compose
independent table writes. Request and response schemas live in
`packages/api-contract` and are shared by the web and API applications. Both
applications use `@glyphquire/document-engine`; neither implements a second
Markdown validator.

## Persistence Model

`notes` stores `id`, `workspaceId`, `title`, `contentMarkdown`, `revision`,
`contentHash`, `ownerId`, `schemaVersion`, `visibility`, `createdAt`, `updatedAt`,
and nullable `deletedAt`. Phase 2 accepts only `visibility = private`.

Registration creates one Personal Workspace and an `owner` membership in the
same provisioning workflow. Existing users receive the same workspace through
an idempotent first-use backfill. Phase 2 exposes no second-workspace,
invitation, or role-management UI, but the membership schema supports
`owner`, `editor`, and `viewer` for future phases.

`note_versions` stores immutable snapshots with the note and workspace IDs,
source revision, Markdown, content hash, creation reason, creator, and creation
time.

`note_operations` stores completed mutation results. Its unique operation
identity is scoped to the authenticated user and note. It records the request
payload hash so reuse of an operation ID with different content fails with
`OPERATION_REUSED` rather than replaying an unrelated response.

Every resource belongs to exactly one workspace. Every query applies workspace
membership in the database predicate. Cross-workspace and deleted-resource
lookups return `404 NOTE_NOT_FOUND` without revealing existence.

A single server-side authorization module owns the action matrix. `owner` and
`editor` may read, edit, rename, soft-delete/restore, create checkpoints, view
versions, and restore versions. `viewer` may list, read, and preview versions
only and cannot enter a writable editor. The automatically provisioned
Personal Workspace has one `owner` during Phase 2.

## First-Party API

Phase 2 adds these `/api/v1` operations:

```text
GET    /workspaces/:workspaceId/notes
POST   /workspaces/:workspaceId/notes
GET    /notes/:noteId
PATCH  /notes/:noteId/title
PUT    /notes/:noteId/content
DELETE /notes/:noteId
POST   /notes/:noteId/restore
GET    /notes/:noteId/versions
POST   /notes/:noteId/versions/checkpoint
GET    /notes/:noteId/versions/:versionId
POST   /notes/:noteId/versions/:versionId/restore
```

List endpoints use cursor pagination and deterministic ordering. Every mutation
requires an `operationId`. Every mutation of an existing note, including
rename, content update, soft delete, note restore, checkpoint, and version
restore, also requires `baseRevision` and increments the monotonic revision on
success.

Create idempotency is scoped by actor, workspace, operation kind, and operation
ID. Existing-note mutation idempotency additionally includes the note ID. The
canonical request hash covers the operation kind, target IDs, base revision,
and the complete validated payload. Same key and same hash replay the recorded
result; same key and different hash return `OPERATION_REUSED`. Replay lookup
precedes CAS so a retry remains replayable after later revisions.

An autosave transaction performs authorization, request-size validation,
Markdown validation, revision compare-and-swap, note update, monotonic revision
increment, optional snapshot creation, operation-result recording, and durable
search-job enqueue. All effects commit or roll back together. A retried
operation returns its recorded result and does not increment the revision
again.

Revision mismatch returns `409 REVISION_CONFLICT` with the current server
revision, Markdown, update time, and editor identity. It does not modify the
note. Restore uses the same conditional-mutation rules.

## Workbench and Editor Behavior

The workbench follows the selected VSCode/HackMD hybrid:

- Explorer contains notes, deleted notes, and version-history entry points;
- Phase 2 has one active note but preserves a tab-oriented UI contract;
- the top bar selects `Visual`, `Source`, or `Split`;
- the command palette opens notes, changes mode, saves immediately, creates a
  checkpoint, and opens history;
- the status bar shows cursor location, Markdown mode, revision, diagnostics,
  and autosave state.

Source Mode provides Markdown syntax highlighting, diagnostic ranges, block
completion, search, and formatting. Visual Mode provides rich-text editing,
slash commands, block controls, and node views.

Mode changes always cross the Document Engine boundary. Visual-to-Source
serializes and validates. Source-to-Visual parses and validates. A fatal Source
parse error leaves Source authoritative, keeps Visual non-writable, and shows a
repairable diagnostic. Stale Visual state can never overwrite invalid Source.

Every built-in block has a bidirectional adapter and the conformance invariant:

```text
Markdown -> Semantic AST -> Milkdown -> Markdown -> Semantic AST
```

`callout`, `sticky`, and `toggle` use editable visual containers. `tabs` and
`columns` support adding, removing, and ordering only their legal children.
`canvas` and `p5` expose attributes and code with a static placeholder and never
execute user code. Unknown and invalid blocks render warning placeholders while
retaining their original kind, attributes, and children for lossless
serialization.

## Autosave and Local Drafts

Autosave waits 1.5 seconds after the last edit. Mode switch, window blur, note
navigation, and `Ctrl/Cmd+S` trigger an immediate attempt. A note has at most one
in-flight save. Changes made during a request are queued for the next save.

The UI exposes `saving`, `saved`, `offline`, `error`, and `conflict` states.
Network retry reuses the same operation ID. Offline edits remain in IndexedDB
and retry after reconnection.

IndexedDB records are keyed by `userId + workspaceId + noteId` and store exact
Markdown, base revision, edit time, pending operation ID, and conflict state.
The client clears a draft only after the server acknowledges the expected new
revision. Logout clears that user's drafts. IndexedDB stores no session secret.
Recovered drafts remain untrusted and are exposed only after a live server
session matches their user and workspace. Logout and account switching
broadcast a local lock/clear event even if the network logout request fails.

Web Locks provides one writer per note. A second browser tab is read-only and
uses BroadcastChannel to show the active writer. Explicit takeover transfers
the lock and makes the previous tab read-only. Server revision CAS remains the
last defense if browser coordination is unavailable or interrupted.

## Conflict Recovery

A `409` stops autosave and opens a dedicated full-screen recovery workspace:

```text
Local draft (editable) | Server revision (read-only)
               highlighted diff
copy actions | continue manual merge | resubmit
```

The IndexedDB draft remains durable across reload or crash. The user can copy
either side and edit the local pane. Resubmission uses the displayed server
revision as the new `baseRevision` and a new operation ID. There is no
last-write-wins action, automatic merge, or silent overwrite.

## Snapshot Policy

An ordinary autosave increments revision but does not necessarily create a
snapshot. A snapshot is created when any of these conditions holds:

- at least five minutes elapsed since the previous snapshot and content
  changed;
- Markdown size changed by at least 10 KiB or 20 percent;
- the user creates a checkpoint;
- before restore, destructive document migration, or major import.

Snapshots are immutable. Restore first preserves the current source and then
creates a new monotonic note revision; it never rewinds the revision counter.

## Error Contract

The stable Phase 2 API error codes are `NOTE_NOT_FOUND`, `REVISION_CONFLICT`,
`DOCUMENT_INVALID`, `DOCUMENT_TOO_LARGE`, `OPERATION_REUSED`, `RATE_LIMITED`,
and `SERVICE_UNAVAILABLE`. Responses carry a request correlation ID. Internal
stack traces, SQL, raw exception details, and cross-workspace existence are not
returned.

## Security Requirements and References

Implementation must follow the fixed baseline in `docs/SPEC.md` section 32 and
record applicable controls in the repository security compliance matrix:

- [OWASP ASVS 5.0.0 Level 2](https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release)
- [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b/)
- [SLSA 1.2 Build Level 1](https://slsa.dev/spec/v1.2/)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [MDN IndexedDB API](https://developer.mozilla.org/docs/Web/API/IndexedDB_API)
- [MDN Web Locks API](https://developer.mozilla.org/docs/Web/API/Web_Locks_API)
- [MDN BroadcastChannel](https://developer.mozilla.org/docs/Web/API/BroadcastChannel)

All requests and responses use shared schema validation. Session-cookie, CSRF,
Origin, CSP, clickjacking, referrer, and MIME-sniffing controls follow the auth
flow and the referenced baseline. The application uses same-origin `/api` in
production; development origins are exact allowlist entries, never wildcards.
Unsafe `/api/v1` methods require an authenticated server session, JSON content,
and CSRF/Origin validation. Structured logs exclude full Markdown and include
only identifiers, revision, byte size, content hash, correlation ID, and stable
error code.

Phase 2 limits are normative:

- Markdown is at most 2 MiB of UTF-8; JSON request bodies are limited to 2.25
  MiB before parsing;
- titles contain 1–200 Unicode characters;
- operation IDs are UUIDs with a maximum textual length of 36 characters;
- list endpoints default to 50 and allow at most 100 items; cursors are at most
  512 bytes;
- autosave mutations allow 60 requests per user per minute, 300 per workspace
  per minute, and 600 per IP per minute;
- other note mutations allow 30 requests per user per minute;
- IndexedDB retains at most 50 drafts per user. Saved or explicitly discarded
  drafts are deleted; unresolved drafts expire after 30 days.

Oversized requests return `413 DOCUMENT_TOO_LARGE`. Rate limits return
`429 RATE_LIMITED` with `Retry-After`. Rate-limit storage remains behind the
port required by `docs/SPEC.md` section 31.

`canvas` and `p5` code remains inert text. Phase 2 may not introduce `eval`,
dynamic code import, executable iframe content, or a runtime message bridge.
Renderers may not use `v-html`, `innerHTML`, or runtime template compilation for
note content. Raw HTML and unknown blocks are escaped placeholders. One URL
policy rejects `javascript:`, active `data:`, `file:`, and unintended `blob:`
URLs and applies safe external-link target/relationship behavior.

## Verification and Acceptance

Unit tests cover EditorSession transitions, debounce and in-flight behavior,
DraftStore, tab takeover, snapshot selection, operation replay, and editor
adapters.

Document conformance covers every built-in block, unknown and invalid block
preservation, and proof that `canvas` and `p5` never execute. API/database
integration covers transaction rollback, concurrent CAS, idempotent replay,
tenant isolation, soft delete, restore, checkpoints, and version restore.

Chrome Playwright E2E covers Visual/Source/Split, all built-ins, offline retry,
reload recovery, tab takeover, simulated `409`, comparison/copy/manual merge,
resubmission, soft deletion, checkpoints, and restore. Chrome evidence also
includes axe, keyboard-only flows, visible focus, reduced motion, and a
screen-reader smoke test supported by the environment.

Phase 2 retains these applicable SPEC section 40 gates:

- 100 KB input p95 below 100 ms;
- Visual/Source switch p95 below one second;
- 1 MB open and save p95 below five seconds;
- no continuous-typing main-thread task above 200 ms;
- `PUT autosave` p95 below one second;
- full parse/validation above 100 KB runs in a Web Worker or uses interruptible
  processing.

A five-user autosave/conflict load test is required. The complete 30-minute
production workload, cross-browser matrix, search, and upload load evidence is
assembled during Production Hardening.

The workspace gate is typecheck, lint, formatting, build, unit/integration
tests, document golden/property tests, Chrome E2E, and disposable-PostgreSQL
migration verification. Security review precedes security-sensitive execution.
Fresh standards/spec review and outcome verification are required before merge.

## Delivery Sequence

Implementation proceeds as independently reviewable vertical slices:

1. workspace, note, version, operation, and durable-job persistence contracts;
2. shared API schemas and transactional note service;
3. workbench shell and CodeMirror Source Mode;
4. EditorSession, DraftStore, tab coordination, and autosave client;
5. Milkdown Visual Mode and all built-in block adapters;
6. mode synchronization, split projection, and fatal-error protection;
7. version history, checkpoints, soft-delete restore, and conflict workspace;
8. accessibility, E2E, conformance, migration, and performance evidence.

Each slice must pass its focused tests and fresh review before the next slice
depends on it.
