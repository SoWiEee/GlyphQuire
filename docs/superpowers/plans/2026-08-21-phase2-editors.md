# Phase 2 Editors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete Phase 2 note-editing loop: tenant-scoped notes and versions, transactional autosave, CodeMirror Source Mode, Milkdown Visual Mode for every built-in block, durable drafts, and explicit revision-conflict recovery.

**Architecture:** `NoteService` is the deep backend module: routes call its small interface and never compose database writes. `EditorSession` is the deep browser module: CodeMirror and Milkdown adapters project one authoritative Markdown state. PostgreSQL, IndexedDB, Web Locks, BroadcastChannel, and editor libraries remain behind adapters at their seams.

**Tech Stack:** Node.js 22+, pnpm, TypeScript strict mode, Vue 3, Pinia, Hono, Zod, Drizzle ORM, PostgreSQL, CodeMirror 6, Milkdown, Vitest, Playwright Chromium, axe-core.

## Global Constraints

- Implement the approved contract in `docs/superpowers/specs/2026-08-21-phase2-editors-design.md`; `docs/SPEC.md` and `docs/MARKDOWN_SPEC.md` remain normative.
- Markdown is canonical. Neither UI nor API may implement a second parser, validator, or serializer outside `@glyphquire/document-engine`.
- Every database query for workspace resources includes authenticated membership scope in its predicate; unauthorized, cross-workspace, and hidden deleted resources return the same `404 NOTE_NOT_FOUND` envelope.
- All existing-note mutations require `baseRevision` and a UUID `operationId`; replay lookup precedes compare-and-swap.
- An autosave transaction atomically performs authorization, validation, CAS, note update, optional snapshot, operation recording, and durable outbox enqueue.
- Phase 2 accepts only private notes. Personal Workspace provisioning is idempotent. `owner`/`editor` may mutate; `viewer` is read-only.
- Markdown is limited to 2 MiB UTF-8, JSON bodies to 2.25 MiB, titles to 1–200 Unicode characters, page size to 100, and cursor length to 512 bytes.
- `canvas` and `p5` remain inert. Do not use `eval`, `Function`, user-controlled dynamic import, executable iframe content, `v-html`, or `innerHTML` for note content.
- Phase 2 browser evidence uses the available Chrome only. Cross-browser P0-14 evidence is deferred and must not be claimed.
- Each task follows red-green-refactor, ends with a focused commit, and receives a fresh spec-compliance and standards review before dependent tasks begin.
- Security-sensitive Tasks 2–7 and 9–13 require the approved `security-executor` role; other implementation uses `executor` unless a task is entirely mechanical.

## Pre-execution Security Gate

Before dispatching Task 1, a `security-reviewer` receives the approved design,
this plan, the current auth/CORS/error/database code, and the fixed references in
`docs/SPEC.md` section 32. The reviewer must confirm that tenant predicates,
same-origin cookie/CSRF behavior, operation identity, transaction atomicity,
draft account separation, inert rendering, limits, logs, and migration evidence
are executable as written. Any Critical or Important finding stops execution;
the main session revises the design/plan and obtains approval before dispatch.
Task 14 remains a separate post-implementation audit.

## Execution Matrix

Tasks execute strictly in numeric order. A worker owns only the paths listed in
its task until its commit and focused review complete; the main session owns
integration, shared-file handoff, finding adjudication, and full-gate runs.
Later tasks may edit a previously released shared file only after consuming the
predecessor commit.

| Task | Depends on    | Exclusive surface                                    | Role                      | Budget  | Stop condition                                     |
| ---- | ------------- | ---------------------------------------------------- | ------------------------- | ------- | -------------------------------------------------- |
| 1    | security gate | tooling, manifests, CI, test configs                 | `mech-executor`           | 45 min  | formatting/test runner cannot reach green          |
| 2    | 1             | auth baseline migration, workspace schema/module     | `security-executor`       | 60 min  | fresh/upgrade migration or provisioning race fails |
| 3    | 2             | note/version/operation/outbox schema                 | `security-executor`       | 60 min  | constraint, journal, or migration evidence fails   |
| 4    | 3             | transport-independent contracts and dependency graph | `security-executor`       | 45 min  | cycle remains or boundary N/N+1 case fails         |
| 5    | 4             | request security, errors, rate limiting, compliance  | `security-executor`       | 60 min  | auth/CSRF/log test or security review fails        |
| 6    | 5             | authorization, lifecycle module, routes              | `security-executor`       | 75 min  | tenant matrix or CAS/idempotency fails             |
| 7    | 6             | autosave, versions, transaction outbox               | `security-executor`       | 90 min  | any injected failure leaves partial state          |
| 8    | 4, 6          | workbench and Source adapter                         | `executor`                | 75 min  | adapter/workbench focused gate fails               |
| 9    | 7, 8          | EditorSession, drafts, locks, autosave client        | `security-executor`       | 90 min  | account separation or state-machine case fails     |
| 10   | 8, 9          | Milkdown and built-in renderers                      | `security-executor`       | 120 min | round-trip loss or execution probe occurs          |
| 11   | 9, 10         | worker parsing and mode/split orchestration          | `security-executor`       | 75 min  | stale race or fatal-source overwrite occurs        |
| 12   | 7, 11         | note/history/conflict UI                             | `security-executor`       | 90 min  | recovery can overwrite without explicit CAS        |
| 13   | 12            | root E2E/performance/load evidence and final CI      | `security-executor`       | 120 min | required Chrome/PostgreSQL evidence unavailable    |
| 14   | 13            | read-only audits; targeted fixes only after approval | `verifier` plus reviewers | 60 min  | any Critical/Important or `REFUTED` result         |

Every worker brief includes the predecessor commit, exact owned paths,
interfaces consumed/produced, focused commands, and the instruction not to
revert other work. Stop immediately on unexpected edits outside ownership,
failed focused/full gates, migration incompatibility, unresolved contract or
security evidence, or unavailable required PostgreSQL/Chrome execution. The
main session does not begin a dependent task until the prior task is committed,
reviewed, and integrated.

---

### Task 1: Make Quality Gates Executable

**Files:**

- Create: `.prettierignore`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `apps/api/package.json`
- Modify: `apps/web/package.json`
- Modify: `packages/database/package.json`
- Modify: `packages/queue/package.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/vitest.integration.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `packages/database/vitest.config.ts`
- Create: `packages/queue/vitest.config.ts`
- Create: `vitest.config.ts`
- Create: `tests/scaffold.test.ts`
- Create: `playwright.config.ts`
- Create: `tests/e2e/scaffold.spec.ts`

**Interfaces:**

- Produces: repository-wide `format:check`, package `test`, API/database integration-test, and Chrome E2E command surfaces used by every later task.

- [ ] **Step 1: Record the current failing gate**

Run:

```bash
pnpm format:check
pnpm --filter @glyphquire/api test
pnpm --filter @glyphquire/web test
pnpm --filter @glyphquire/database test
```

Expected: formatting and missing-package-test failures reproduce the current gaps.

- [ ] **Step 2: Add deterministic test scripts and fixture exclusions**

Use `.prettierignore` only for semantic Markdown fixtures whose whitespace is test data:

```text
packages/document-engine/tests/fixtures/**/input.md
packages/document-engine/tests/fixtures/**/expected.md
.superpowers/
```

Add workspace dev dependencies for `vitest`, `happy-dom`,
`@vue/test-utils`, `@testing-library/vue`, `@playwright/test`, `axe-core`,
`@axe-core/playwright`, and `tsx`. Add `test: "vitest run"` to API, web,
database, and queue. Add API
`test:integration: "vitest run --config vitest.integration.config.ts"`.
Seed each new package runner with one real configuration/import smoke test so
empty suites never pass accidentally. Add root scripts:

```json
{
  "test:integration": "pnpm --filter @glyphquire/api test:integration",
  "test:cross-package": "vitest run --config vitest.config.ts",
  "test:e2e": "playwright test",
  "test:load:phase2": "tsx tests/load/autosave-conflict.ts",
  "test:phase2": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm -r test && pnpm test:cross-package && pnpm test:integration && pnpm test:e2e"
}
```

Configure Vitest with Node environment for API/database/queue and `happy-dom`
for web. Root `vitest.config.ts` owns `tests/scaffold.test.ts` and
`tests/conformance/**/*.test.ts`.
Playwright owns `tests/e2e/**/*.spec.ts` and
`tests/performance/**/*.perf.spec.ts`. The root `tsx` load command owns
`tests/load/**/*.ts`.

- [ ] **Step 3: Normalize the non-fixture formatting baseline**

Run `pnpm exec prettier --write .` after the fixture exclusions are active.
Inspect `git diff --name-only` and `git diff`; every change must be a Prettier
rewrite under `.github/`, `apps/`, `packages/`, `docs/`, or a root Markdown,
JSON, YAML, or lockfile. Stop on semantic changes or any fixture Markdown
change. Stage the complete inspected formatting set, then run
`pnpm format:check`. Expected: PASS.

- [ ] **Step 4: Add CI services and gates**

Add PostgreSQL 17 as a GitHub Actions service with a health check and expose a
dedicated `TEST_DATABASE_URL`. At Task 1, CI runs install, typecheck, lint,
format, build, recursive unit tests, cross-package scaffold, and Chrome scaffold
only; integration/load/product E2E gates are enabled by their owning later
tasks. Pin Playwright Chromium installation with
`pnpm exec playwright install --with-deps chromium`.

- [ ] **Step 5: Verify and commit**

Run `pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm test`. Expected: PASS.

```bash
git add .prettierignore .github apps packages docs README.md package.json pnpm-lock.yaml pnpm-workspace.yaml playwright.config.ts vitest.config.ts tests/scaffold.test.ts tests/e2e/scaffold.spec.ts
git commit -m "test: establish phase2 quality gates"
```

### Task 2: Add Workspace and Membership Persistence

**Files:**

- Create: `packages/database/src/schema/workspaces.ts`
- Create: `packages/database/src/schema/workspaces.test.ts`
- Modify: `packages/database/src/schema/index.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/src/migrations/0000_phase0_auth.sql`
- Create: `packages/database/src/migrations/0001_phase2_workspaces.sql`
- Create: `packages/database/src/migrations/meta/_journal.json`
- Create: `packages/database/src/migrations/meta/0000_snapshot.json`
- Create: `packages/database/src/migrations/meta/0001_snapshot.json`
- Create: `packages/database/src/migrations/verify-baseline.ts`
- Modify: `packages/database/src/migrate.ts`
- Modify: `packages/database/package.json`
- Modify: `packages/shared/src/env.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Create: `infra/postgres/init/001_roles.sql`
- Create: `apps/api/src/modules/workspaces/WorkspaceService.ts`
- Create: `apps/api/src/modules/workspaces/WorkspaceService.integration.test.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Create: `apps/api/src/middleware/personal-workspace.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/auth/src/server.ts`
- Modify: `packages/auth/src/index.ts`

**Interfaces:**

- Produces: `WorkspaceService.ensurePersonalWorkspace(actorId): Promise<WorkspaceSummary>` and membership rows consumed by authorization and note queries.

- [ ] **Step 1: Write failing schema and provisioning tests**

Assert UUID public IDs, one idempotently provisioned Personal Workspace per user, one owner membership, and allowed roles only:

```ts
type WorkspaceRole = "owner" | "editor" | "viewer";
type WorkspaceSummary = { id: string; name: "Personal"; role: "owner" };
```

Run `pnpm --filter @glyphquire/database test -- workspaces` and the API integration test. Expected: FAIL because schema/service do not exist.

- [ ] **Step 2: Establish an executable migration baseline**

Generate and review `0000_phase0_auth.sql` from the current auth schema and
start a committed Drizzle journal. `verify-baseline.ts` fingerprints the four
auth tables, columns, foreign keys, indexes, and uniqueness constraints. On an
empty database it permits applying `0000`. On an existing unjournaled Phase 0
database it records `0000` as baselined only after the exact fingerprint
matches; malformed or partially matching schemas fail closed. After successful
fingerprinting it computes the exact SHA-256 hash of the committed `0000` SQL
and inserts that hash and journal timestamp/version into Drizzle's database
migration table (`drizzle.__drizzle_migrations`). Updating only
`meta/_journal.json` does not mark an existing database as migrated. Assert the
database migration table and repository journal both contain exactly `0000`
before Phase 2 migrations.

Add exact package commands:

```json
{
  "db:verify-baseline": "tsx src/migrations/verify-baseline.ts",
  "db:migrate:test": "tsx src/migrate.ts"
}
```

`packages/database/src/migrate.ts` requires privileged
`MIGRATION_DATABASE_URL`; runtime `createDb` continues to require the distinct
least-privilege `DATABASE_URL`. Update shared env validation, `.env.example`,
Docker Compose, and the PostgreSQL init script to create separate migration and
application roles. The application role receives DML on application tables but
cannot create, alter, or drop schema objects.

- [ ] **Step 3: Implement workspace schema constraints and migration**

Create `workspaces` and `workspace_members` with foreign keys to `user`, unique `(workspaceId, userId)`, a role check, and a unique personal-owner key that makes provisioning race-safe. Export tables and relations from `schema/index.ts` and re-export the tables plus inferred row types from `packages/database/src/index.ts` for backend persistence modules. Routes and frontend code may not import raw tables. Generate and review `0001_phase2_workspaces.sql`; assert the journal sequence is `0000`, `0001`.

- [ ] **Step 4: Implement and connect the deep provisioning module**

`ensurePersonalWorkspace` performs insert-on-conflict and returns the existing or new owner membership in one transaction. Do not expose raw Drizzle tables through its interface.

Invoke it after successful new-user registration through the Better Auth
post-registration hook owned by `routes/auth.ts`. Also invoke it from the first
authenticated `/api/v1` request path for pre-existing users. Registration must
not report success unless provisioning succeeds; retry is idempotent. Test new
registration, pre-existing first use, injected rollback, and concurrent calls:
each leaves exactly one Personal Workspace and one owner membership.

Extend `createAuth` with the adapter callback
`onUserCreated(userId: string): Promise<void>` in `packages/auth/src/server.ts`;
the auth package never imports API modules. The API passes
`WorkspaceService.ensurePersonalWorkspace` through this callback. Better Auth's
user row is not rolled back if the post-create callback fails: registration
returns `SERVICE_UNAVAILABLE`, and an idempotent retry or the
`personal-workspace.ts` middleware on the first authenticated `/api/v1`
request repairs provisioning before note routes run.

- [ ] **Step 5: Verify fresh and upgrade migrations**

Run against two disposable PostgreSQL databases:

```bash
MIGRATION_DATABASE_URL=postgres://migration:.../glyphquire_fresh pnpm --filter @glyphquire/database db:migrate:test
MIGRATION_DATABASE_URL=postgres://migration:.../glyphquire_phase0 pnpm --filter @glyphquire/database db:verify-baseline
MIGRATION_DATABASE_URL=postgres://migration:.../glyphquire_phase0 pnpm --filter @glyphquire/database db:migrate:test
```

The fresh database creates auth plus workspaces; the exact Phase 0 database is
baselined then upgraded; a malformed Phase 0 fingerprint is rejected. Assert
the Drizzle journal version after every path.

Connect with the runtime `DATABASE_URL` after migration and assert SELECT,
INSERT, UPDATE, and DELETE on owned application rows work while CREATE TABLE,
ALTER TABLE, DROP TABLE, and writes to the migration journal fail.

- [ ] **Step 6: Commit**

```bash
git add packages/database packages/shared packages/auth apps/api/src/modules/workspaces apps/api/src/middleware/personal-workspace.ts apps/api/src/routes/auth.ts apps/api/src/app.ts .env.example docker-compose.yml infra/postgres/init/001_roles.sql
git commit -m "feat: provision personal workspaces"
```

### Task 3: Add Notes, Versions, Operations, and Outbox Schema

**Files:**

- Create: `packages/database/src/schema/notes.ts`
- Create: `packages/database/src/schema/note-versions.ts`
- Create: `packages/database/src/schema/note-operations.ts`
- Create: `packages/database/src/schema/document-jobs.ts`
- Create: `packages/database/src/schema/notes.test.ts`
- Modify: `packages/database/src/schema/index.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/src/migrations/0002_phase2_notes.sql`
- Create: `packages/database/src/migrations/meta/0002_snapshot.json`
- Modify: `packages/database/src/migrations/meta/_journal.json`

**Interfaces:**

- Produces: constrained persistence tables consumed only inside backend modules; no route imports schema tables directly.

- [ ] **Step 1: Write failing constraint tests**

Cover workspace/user foreign keys, `visibility = private`, positive monotonic revisions, unique `(noteId, revision)` versions, immutable snapshot rows, unique operation scopes, unique document-job identity `(noteId, revision, operationId)`, and workspace identity on notes, versions, operations, and jobs.

- [ ] **Step 2: Implement schemas and indexes**

Use random UUID primary keys. Store `contentHash`, `schemaVersion`, exact Markdown, nullable `deletedAt`, snapshot reason, canonical request hash, recorded response JSON, and outbox state. Index membership-scoped list and CAS predicates.

Re-export note, version, operation, and document-job tables plus inferred row
types from `packages/database/src/index.ts` for backend persistence modules.
Do not expose them through the API contract package.

- [ ] **Step 3: Add reviewed SQL migration**

Generate with `pnpm db:generate`, inspect the SQL, and keep the reviewed migration in version control. Application startup must not push schema.
Confirm the generation diff is limited to owned schema, `0002` SQL/snapshot,
and `_journal.json`, whose repository sequence is exactly `0000`, `0001`,
`0002`.

- [ ] **Step 4: Verify migrations and commit**

Run database tests plus disposable fresh and Phase 0 upgrade paths with
`MIGRATION_DATABASE_URL`. Inspect `drizzle.__drizzle_migrations` for the exact
ordered hashes/versions `0000`, `0001`, `0002`. Re-run runtime-role DML success
and CREATE/ALTER/DROP/journal-write denial.

```bash
git add packages/database
git commit -m "feat: add note persistence schema"
```

### Task 4: Define Shared Note Contracts and Stable Errors

**Files:**

- Create: `packages/api-contract/src/notes/schemas.ts`
- Create: `packages/api-contract/src/notes/types.ts`
- Create: `packages/api-contract/src/notes/errors.ts`
- Create: `packages/api-contract/src/notes/schemas.test.ts`
- Modify: `packages/api-contract/src/index.ts`
- Modify: `packages/api-contract/package.json`
- Modify: `apps/api/package.json`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: Zod schemas and inferred types for all eleven endpoints, cursor envelopes, `NoteMutation`, `NoteConflict`, and `ApiErrorEnvelope`.
- Removes: the contract package's dependency on `@glyphquire/api/app`; the API depends on contracts, never the reverse.

- [ ] **Step 1: Write failing boundary tests**

Use explicit N/N+1 cases: 2 MiB and 2 MiB + 1 byte UTF-8 Markdown; 512 and
513 UTF-8-byte cursors including multibyte input; 1, 200, 0, and 201 Unicode
code-point titles; canonical 36-character UUIDs plus malformed/overlong IDs;
page sizes omitted, 1, 100, 0, and 101; and missing `baseRevision` on rename,
save, delete, note restore, checkpoint, and version restore. Unknown visibility
is rejected and Phase 2 accepts only `private`.

- [ ] **Step 2: Define exact shared interfaces**

```ts
type NoteMutation = { operationId: string; baseRevision: number };
type SaveNoteInput = NoteMutation & { contentMarkdown: string };
type NoteConflict = {
  code: "REVISION_CONFLICT";
  noteId: string;
  serverRevision: number;
  serverMarkdown: string;
  serverUpdatedAt: string;
  lastEditedBy: { displayName: string } | null;
  requestId: string;
};
type ApiErrorCode =
  | "NOTE_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "DOCUMENT_INVALID"
  | "DOCUMENT_TOO_LARGE"
  | "OPERATION_REUSED"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE";
type ApiErrorEnvelope = { error: { code: ApiErrorCode; message: string; requestId: string } };
```

Define create idempotency without `noteId`; all other mutation schemas include `baseRevision`.
`lastEditedBy` deliberately exposes display name only—never user ID, email,
session, IP, or user agent. Add schema/route acceptance cases proving an
authorized member receives every field above and an unauthorized caller
receives only the uniform `NOTE_NOT_FOUND` envelope with no conflict fields.

- [ ] **Step 3: Export a transport-independent client contract**

Keep Zod schemas and plain types independent of Hono. Hono route typing may consume them from `apps/api`, while `createApiClient` becomes a thin adapter rather than the package's only interface.

Remove `@glyphquire/api` and Hono from `@glyphquire/api-contract`. Add
`@glyphquire/api-contract`, `@glyphquire/document-engine`, and
`@glyphquire/queue` workspace dependencies to API, and add
`@glyphquire/api-contract` plus `@glyphquire/document-engine` to web. Update the
lockfile in this task. Verify `pnpm -r list --depth -1` and a dependency-cycle
check show contracts below both applications and no API-to-contract cycle. Add
one compile-time test proving API and web consume the same exported Zod schema.

- [ ] **Step 4: Verify and commit**

Run contract tests, typecheck, and dependency-cycle inspection.

```bash
git add packages/api-contract apps/api/package.json apps/web/package.json pnpm-lock.yaml
git commit -m "feat: define note API contracts"
```

### Task 5: Establish Authenticated Request Security

**Files:**

- Create: `apps/api/src/middleware/request-context.ts`
- Create: `apps/api/src/middleware/security.ts`
- Create: `apps/api/src/middleware/rate-limit.ts`
- Create: `apps/api/src/middleware/PostgresRateLimitAdapter.ts`
- Create: `apps/api/src/middleware/security.integration.test.ts`
- Modify: `apps/api/src/middleware/cors.ts`
- Modify: `apps/api/src/middleware/error-handler.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/auth/src/server.ts`
- Modify: `packages/shared/src/env.ts`
- Create: `packages/database/src/schema/rate-limit-buckets.ts`
- Modify: `packages/database/src/schema/index.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/src/migrations/0003_phase2_rate_limits.sql`
- Create: `packages/database/src/migrations/meta/0003_snapshot.json`
- Modify: `packages/database/src/migrations/meta/_journal.json`
- Modify: `.env.example`
- Create: `docs/security/phase2-compliance-matrix.md`

**Interfaces:**

- Produces: authenticated `RequestContext { requestId, actorId, session }`, exact-origin/CSRF enforcement, security headers, rate-limit port, and scrubbed error/log seam.

- [ ] **Step 1: Write failing security tests**

Test missing/evil/null Origin, cross-site form content types, unauthenticated requests, forged user IDs, and state-changing GETs. Assert same-origin JSON succeeds. Inject sentinel Markdown, cookie, SQL, and stack strings and assert neither response nor captured structured log contains them.

Use one validated `WEB_ORIGIN` value as the exact trusted-origin source for
Better Auth and Hono. Production serves same-origin `/api` and emits no
credentialed cross-origin CORS headers. Unsafe methods reject missing, `null`,
malformed, and unlisted Origin and non-JSON content. Fetch Metadata may reject
additional `cross-site` requests but cannot authorize a request lacking the
exact Origin. Assert session issue and logout clearing use HttpOnly, host-only,
Path `/`, SameSite `Lax`, and Secure under HTTPS across `/api/auth/*` and
`/api/v1/*`; development Secure behavior follows the explicit HTTP test origin
without weakening production assertions.

Send Content-Length, chunked, and multibyte JSON bodies at exactly 2.25 MiB and
2.25 MiB + 1 byte. Assert the latter is rejected before JSON parsing with
`413 DOCUMENT_TOO_LARGE`, no database write, and no echoed body content.

Add table-driven rate-limit tests at exact boundaries: autosave 60/61 per user,
300/301 per workspace, and 600/601 per IP in one minute; other mutations 30/31
per user. Confirm the strictest exhausted scope wins, windows reset only after
the injected clock advances, `429` includes `Retry-After`, and rejected requests
perform no database write.

Add auth-route boundary and concurrency cases: failed login 10/11 per
account-and-IP in 15 minutes, all login attempts 30/31 per IP in 15 minutes,
registration 5/6 per IP per hour, and password reset 5/6 per account-and-IP per
hour. Test two API instances concurrently consume the same PostgreSQL bucket.
Only direct peers matching configured `TRUSTED_PROXY_CIDRS` may supply the
selected forwarded-IP header; untrusted peers cannot spoof it. Shared-limiter
database failure makes protected production requests fail closed.

- [ ] **Step 2: Implement request context and CSRF/origin policy**

Use the server session only; never accept actor identity from the body.
`WEB_ORIGIN` is parsed once and injected into both Better Auth and Hono.
Production uses same-origin `/api`; development permits exactly that configured
origin. Unsafe `/api/v1` methods require JSON and the exact Origin policy above.

- [ ] **Step 3: Implement response hardening and safe errors**

Add CSP, `frame-ancestors`/X-Frame-Options, `Referrer-Policy`, and `nosniff`. Generate or validate request IDs. Map only allowlisted public errors and log scrubbed structured fields.

- [ ] **Step 4: Implement rate-limit adapter and limits**

Define `RateLimitPort.consume(key, limit, windowMs)` with an in-memory unit-test
adapter and a PostgreSQL production adapter using atomic bucket upsert/update.
Create the rate-limit schema and reviewed `0003` migration. Production startup
requires this shared adapter and fails if it cannot initialize. Parse trusted
proxy CIDRs at startup and derive client IP from direct peer unless that peer is
trusted. Apply note and auth limits and emit `Retry-After`.

Confirm migration generation changes only the owned rate-limit schema, `0003`
SQL/snapshot, and `_journal.json`; the repository sequence is exactly `0000`,
`0001`, `0002`, `0003`. Reproduce disposable fresh and Phase 0 upgrade paths
with `MIGRATION_DATABASE_URL`, inspect the database migration table for those
ordered hashes/versions, and re-run runtime-role DML success plus
CREATE/ALTER/DROP/journal-write denial.

- [ ] **Step 5: Record compliance evidence and commit**

Inventory every fixed baseline and applicable section-32 control: OWASP ASVS,
NIST SP 800-63B-4, SLSA 1.2 Build L1, Authentication, Session Management, CSRF,
XSS, CSP/HTML, content, sandbox, and database controls. Each row records status
(`applicable`, `implemented`, or `documented exception`), implementation
evidence, automated/manual verification, and—when excepted—rationale, risk,
compensating control, and approver. Do not copy external catalogs.

```bash
git add apps/api packages/auth packages/shared packages/database .env.example docs/security
git commit -m "feat: secure authenticated note requests"
```

### Task 6: Implement Authorization and NoteService Reads/Lifecycle

**Files:**

- Create: `apps/api/src/modules/notes/authorization.ts`
- Create: `apps/api/src/modules/notes/NoteService.ts`
- Create: `apps/api/src/modules/notes/NoteService.integration.test.ts`
- Create: `apps/api/src/routes/v1/notes.ts`
- Create: `apps/api/src/routes/v1/notes.integration.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**

- Produces: one `authorize(actor, action, resource)` module and a `NoteService` interface for list/create/get/rename/delete/restore. Routes only parse contracts and call this module.

- [ ] **Step 1: Write the two-user/two-workspace matrix**

Exercise every resource identifier as owner, editor, viewer, unrelated user, and deleted-note caller. Assert uniform 404s and no title/Markdown/editor leak. Assert viewers cannot mutate.

For create, rename, soft delete, and note restore, inject failures immediately
before and after the note change, operation-result insert, and document-job
insert. Assert each mutation is one transaction: the note change, operation
record, and derived-state outbox row either all commit or all roll back.
Concurrent identical create requests using the
`(actorId, workspaceId, operationKind, operationId)` scope create one note and
return equivalent recorded success responses to both callers. Existing-note operations use
`(actorId, workspaceId, noteId, operationKind, operationId)`. Same key with a
different canonical hash returns `OPERATION_REUSED`; losing CAS writes nothing.

- [ ] **Step 2: Define the deep interface**

```ts
interface NoteService {
  list(actorId: string, input: ListNotesInput): Promise<NotePage>;
  create(actorId: string, input: CreateNoteInput): Promise<NoteResult>;
  get(actorId: string, noteId: string): Promise<NoteResult>;
  rename(actorId: string, noteId: string, input: RenameNoteInput): Promise<NoteResult>;
  softDelete(actorId: string, noteId: string, input: DeleteNoteInput): Promise<NoteResult>;
  restore(actorId: string, noteId: string, input: RestoreNoteInput): Promise<NoteResult>;
}
```

- [ ] **Step 3: Implement membership-scoped predicates and idempotency**

Every query joins or subqueries current membership. Each lifecycle mutation
opens one database transaction, checks replay before CAS, conditionally changes
the note, records the exact response, and inserts the uniquely identified
derived-state document job before commit. If concurrent identical requests both
miss the initial replay, the unique-operation/CAS loser performs an authorized
operation re-read: same hash returns the exact recorded response; different
hash returns `OPERATION_REUSED`. Conditional mutations
include workspace, visibility/deletion state, and revision. Zero updated rows
are resolved through another membership-scoped query in the same authorization
scope.

- [ ] **Step 4: Mount `/api/v1` routes and verify**

Routes use shared schemas and error envelopes. Run API/database integration tests and verify deterministic cursor order.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/notes apps/api/src/routes/v1 apps/api/src/app.ts
git commit -m "feat: add tenant-scoped note lifecycle"
```

### Task 7: Implement Transactional Autosave and Version History

**Files:**

- Create: `apps/api/src/modules/notes/snapshot-policy.ts`
- Create: `apps/api/src/modules/notes/snapshot-policy.test.ts`
- Create: `apps/api/src/modules/notes/NoteWriter.ts`
- Create: `apps/api/src/modules/notes/NoteWriter.integration.test.ts`
- Create: `apps/api/src/routes/v1/versions.ts`
- Create: `apps/api/src/routes/v1/versions.integration.test.ts`
- Modify: `apps/api/src/modules/notes/NoteService.ts`
- Modify: `packages/queue/src/index.ts`
- Create: `packages/queue/src/document-jobs.ts`
- Create: `packages/queue/src/outbox-dispatcher.ts`
- Create: `packages/queue/src/outbox-dispatcher.integration.test.ts`
- Modify: `packages/queue/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `save`, version list/preview, checkpoint, and version restore behind
  NoteService. `NoteWriter` owns the in-transaction outbox insert; the queue
  package owns post-commit claim/dispatch/retry through a separate adapter.

- [ ] **Step 1: Write snapshot and transaction failure tests**

Compare deltas against the latest immutable snapshot, not the latest autosave.
Let `currentBytes` and `snapshotBytes` be UTF-8 byte lengths and
`deltaBytes = abs(currentBytes - snapshotBytes)`. When `snapshotBytes > 0`, the
20 percent trigger is the integer comparison
`deltaBytes * 100 >= snapshotBytes * 20` with no floating-point rounding. When
`snapshotBytes === 0`, skip the percentage trigger and use the 10 KiB absolute
trigger. Test equality and N-1 for exactly five minutes, exactly 10 KiB, and
the integer 20 percent comparison. Test manual, restore, migration, and import triggers. Inject
failure after authorization, validation, CAS, update, snapshot, operation
record, and outbox insert; after each failure inspect notes, versions,
operations, and document-jobs tables and assert no partial state.

- [ ] **Step 2: Write concurrency/idempotency tests**

Concurrent distinct requests at one base revision yield one success and one
authorized `409`. The conflict schema must contain current revision, exact
server Markdown, updated time, and minimized editor identity only after tenant
authorization; sentinel Markdown must not appear in logs. Identical concurrent
requests increment once. Same key/different canonical payload returns
`OPERATION_REUSED`. If concurrent identical requests both miss replay, the
unique-operation/CAS loser re-reads the authorized operation record and both
callers receive equivalent recorded success responses. Losing CAS writes no
version, operation, or job.

- [ ] **Step 3: Implement NoteWriter transaction**

Validate exact UTF-8 size and Document Engine result before persistence. Within
one Drizzle transaction perform replay, authorization, CAS, hash/update,
snapshot, operation recording, and direct `document_jobs` insert. The job has a
database uniqueness constraint on `(noteId, revision, operationId)`. No route or
external queue call participates in this transaction, and the database package
does not depend on the queue package.

- [ ] **Step 4: Implement post-commit dispatch and retry**

Define the queue module interface:

```ts
interface DocumentJobDispatcher {
  dispatchBatch(handler: (job: DocumentJob) => Promise<void>): Promise<DispatchSummary>;
}
```

Its Postgres adapter atomically claims due rows with row locking, increments
attempts, acknowledges success, and schedules bounded exponential retry on
failure before a terminal dead-letter state. Duplicate identities dispatch
once. A handler for an older note revision must prove current-revision equality
before replacing derived state. Integration tests cover concurrent dispatchers,
crash/reclaim after lock timeout, duplicate rows, stale jobs, retry schedule,
and terminal failure.

- [ ] **Step 5: Implement immutable versions and restore**

Checkpoint and restore require CAS. Restore snapshots current source first, applies historical Markdown as a new revision, and never rewinds the counter.

- [ ] **Step 6: Mount routes, verify, and commit**

Run integration, property/golden, tenant matrix, and failure-injection tests.

```bash
git add apps/api/src/modules/notes apps/api/src/routes/v1 packages/queue pnpm-lock.yaml
git commit -m "feat: add transactional autosave and history"
```

### Task 8: Build the Workbench and CodeMirror Source Mode

**Files:**

- Modify: `apps/web/package.json`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/layouts/AppLayout.vue`
- Create: `apps/web/src/pages/WorkbenchPage.vue`
- Create: `apps/web/src/components/workbench/Workbench.vue`
- Create: `apps/web/src/components/workbench/ExplorerPane.vue`
- Create: `apps/web/src/components/workbench/EditorTabs.vue`
- Create: `apps/web/src/components/workbench/TopBar.vue`
- Create: `apps/web/src/components/workbench/CommandPalette.vue`
- Create: `apps/web/src/components/workbench/StatusBar.vue`
- Create: `apps/web/src/editors/types.ts`
- Create: `apps/web/src/editors/source/CodeMirrorSourceAdapter.ts`
- Create: `apps/web/src/components/source/SourceEditor.vue`
- Create: `apps/web/src/editors/source/CodeMirrorSourceAdapter.test.ts`

**Interfaces:**

- Produces: VSCode-style shell and `EditorAdapter` seam implemented by CodeMirror.

- [ ] **Step 1: Install locked editor/test dependencies**

Add CodeMirror state/view/commands/search/autocomplete/lint/Markdown packages, Vue Test Utils, Testing Library, and happy-dom. Commit the lockfile only with the task implementation.

- [ ] **Step 2: Write failing adapter and keyboard tests**

```ts
interface EditorAdapter {
  mount(host: HTMLElement): void;
  setMarkdown(markdown: string): void;
  getMarkdown(): string;
  setReadOnly(readOnly: boolean): void;
  onChange(listener: (markdown: string) => void): () => void;
  focus(): void;
  destroy(): void;
}
```

Test source edits, read-only projection, diagnostics, completion, focus, teardown, and command shortcuts.

- [ ] **Step 3: Implement adapter and workbench shell**

Keep CodeMirror extensions private to the adapter. Add the workspace route, one active note, tab-shaped state, Explorer, command palette, mode control, and status bar with accessible labels/focus order.

- [ ] **Step 4: Verify and commit**

Run web tests, typecheck, lint, and build.

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat: add workbench and source editor"
```

### Task 9: Implement EditorSession, DraftStore, Locks, and Autosave

**Files:**

- Create: `apps/web/src/editors/editor-session.types.ts`
- Create: `apps/web/src/editors/EditorSession.ts`
- Create: `apps/web/src/editors/EditorSession.test.ts`
- Create: `apps/web/src/persistence/idb.ts`
- Create: `apps/web/src/persistence/DraftStore.ts`
- Create: `apps/web/src/persistence/DraftStore.test.ts`
- Create: `apps/web/src/coordination/NoteLock.ts`
- Create: `apps/web/src/coordination/TabChannel.ts`
- Create: `apps/web/src/coordination/NoteLock.test.ts`
- Create: `apps/web/src/autosave/AutosaveController.ts`
- Create: `apps/web/src/autosave/AutosaveController.test.ts`
- Create: `apps/web/src/api/NoteClient.ts`

**Interfaces:**

- Produces: the sole writable browser module and adapters for remote notes, IndexedDB, Web Locks, BroadcastChannel, clock, and connectivity.

- [ ] **Step 1: Write the state-machine tests**

Cover `clean -> dirty -> saving -> saved`, offline/error retry, one in-flight request, queued edits, 1.5-second debounce, immediate triggers, stable retry operation ID, and `409 -> conflict`.

- [ ] **Step 2: Define the small session interface**

```ts
interface EditorSession {
  snapshot(): EditorSessionState;
  edit(markdown: string): void;
  switchMode(mode: "visual" | "source" | "split"): Promise<SwitchResult>;
  saveNow(): Promise<void>;
  subscribe(listener: (state: EditorSessionState) => void): () => void;
  dispose(): Promise<void>;
}
```

Keep timers, operation IDs, drafts, locks, and adapters inside the implementation.

- [ ] **Step 3: Implement secure DraftStore and tab coordination**

Key drafts by user/workspace/note, cap at 50, expire unresolved drafts after 30 days, and never surface a draft before a live matching session. Treat recovered fields as untrusted. Logout/account switch clears and broadcasts locally even if network logout fails. Second tabs are read-only until explicit takeover.

Test 50/51-draft eviction, exactly 30 days versus 30 days plus one
millisecond, two browser identities sharing one profile, expired sessions,
tampered workspace/note/revision/operation fields, logout without network, and
simultaneous takeover. User B must never enumerate or restore User A's draft.

- [ ] **Step 4: Implement autosave and NoteClient adapters**

Use shared schemas for every request/response. Server acknowledgements clear only the matching draft/revision. Stale responses cannot regress state.

- [ ] **Step 5: Verify and commit**

Run fake IndexedDB, fake clock, multi-tab, adapter contract, web typecheck/lint/build tests.

```bash
git add apps/web/src/editors apps/web/src/persistence apps/web/src/coordination apps/web/src/autosave apps/web/src/api
git commit -m "feat: add authoritative editor session"
```

### Task 10: Add Milkdown Visual Mode and Built-in Adapters

**Files:**

- Modify: `apps/web/package.json`
- Create: `apps/web/src/editors/visual/MilkdownVisualAdapter.ts`
- Create: `apps/web/src/editors/visual/schema.ts`
- Create: `apps/web/src/editors/visual/nodes/callout.ts`
- Create: `apps/web/src/editors/visual/nodes/sticky.ts`
- Create: `apps/web/src/editors/visual/nodes/toggle.ts`
- Create: `apps/web/src/editors/visual/nodes/tabs.ts`
- Create: `apps/web/src/editors/visual/nodes/columns.ts`
- Create: `apps/web/src/editors/visual/nodes/runtime.ts`
- Create: `apps/web/src/editors/visual/nodes/unknown.ts`
- Create: `apps/web/src/components/visual/VisualEditor.vue`
- Create: `apps/web/src/editors/visual/MilkdownVisualAdapter.test.ts`
- Create: `tests/conformance/editor-blocks.test.ts`

**Interfaces:**

- Produces: a second `EditorAdapter` with identical external interface; hides ProseMirror/Milkdown details and all built-in node-view implementations.

- [ ] **Step 1: Install locked Milkdown dependencies and write failing conformance cases**

For every built-in and unknown/invalid fixture assert:

```text
Markdown -> Semantic AST -> Milkdown -> Markdown -> Semantic AST
```

Compare semantic-normalized ASTs. Assert directive kind, attributes, and children survive.

- [ ] **Step 2: Implement safe schema and simple nodes**

Implement callout, sticky, and toggle node views using Vue/DOM text nodes only. Centralize URL validation; reject active schemes and apply safe external-link attributes. Never enable raw HTML rendering.

- [ ] **Step 3: Implement structural and inert runtime nodes**

Tabs/columns enforce legal children and ordering. Canvas/p5 show editable attributes/source and static placeholders. Unknown/invalid nodes are escaped, warning-labeled, and lossless.

- [ ] **Step 4: Add execution-negative security tests**

Feed raw script/SVG handlers, `javascript:` and hostile image URLs, and p5/canvas DOM/fetch code. Assert no execution, navigation, network call, iframe, Worker, or dynamic import.

- [ ] **Step 5: Verify and commit**

Run conformance, document-engine, web, typecheck, lint, and build.

```bash
git add apps/web tests/conformance pnpm-lock.yaml
git commit -m "feat: add safe visual editor blocks"
```

### Task 11: Add Mode Synchronization, Split Projection, and Worker Parsing

**Files:**

- Create: `apps/web/src/workers/document-worker.ts`
- Create: `apps/web/src/workers/document-worker.test.ts`
- Create: `apps/web/src/editors/DocumentWorkerClient.ts`
- Create: `apps/web/src/components/split/SplitEditor.vue`
- Create: `apps/web/src/editors/mode-sync.test.ts`
- Modify: `apps/web/src/editors/EditorSession.ts`
- Modify: `apps/web/src/components/workbench/Workbench.vue`

**Interfaces:**

- Produces: ordered parse/validate/serialize requests, fatal-source protection, mode switch, and a read-only split projection.

- [ ] **Step 1: Write failing race and fatal-error tests**

Assert stale worker responses are ignored, only the active pane emits edits, split is read-only, Visual-to-Source serializes/validates, Source-to-Visual parses/validates, and fatal Source input cannot activate writable Visual or be overwritten.

- [ ] **Step 2: Implement versioned worker messages**

```ts
type DocumentRequest = { requestId: number; markdown: string; operation: "parse" | "validate" };
type DocumentResponse = { requestId: number; result: ParseResult };
```

Move full parse/validation above 100 KB to the worker. Ensure cancellation/ignore semantics and exact source retention.

- [ ] **Step 3: Implement split/mode orchestration**

EditorSession owns switch ordering and commits a mode only after the target adapter accepts the current validated state. Preserve selection where adapter capability permits without making selection part of canonical state.

- [ ] **Step 4: Verify and commit**

Run race, 100 KB/1 MB, fatal source, round-trip, and build tests.

```bash
git add apps/web/src/workers apps/web/src/editors apps/web/src/components/split apps/web/src/components/workbench
git commit -m "feat: synchronize editor modes safely"
```

### Task 12: Build Notes, History, and Conflict Recovery UI

**Files:**

- Create: `apps/web/src/components/notes/NoteExplorer.vue`
- Create: `apps/web/src/components/history/VersionHistory.vue`
- Create: `apps/web/src/components/history/VersionPreview.vue`
- Create: `apps/web/src/components/history/CheckpointDialog.vue`
- Create: `apps/web/src/components/conflict/ConflictWorkspace.vue`
- Create: `apps/web/src/components/conflict/ConflictWorkspace.test.ts`
- Modify: `apps/web/src/pages/WorkbenchPage.vue`
- Modify: `apps/web/src/stores/index.ts`

**Interfaces:**

- Produces: minimal note lifecycle, versions, checkpoint/restore, and full-screen local-editable/server-read-only conflict workflow.

- [ ] **Step 1: Write failing user-flow tests**

Cover create/open/rename/delete/restore, version list/preview, checkpoint, CAS restore, and the complete `409` flow. Assert no last-write-wins action exists and server Markdown cannot be edited in recovery.

- [ ] **Step 2: Implement notes and history**

Use NoteClient only. Show deleted notes in a separate authorized view. Require explicit confirmation for restore and display the target revision before mutation.

- [ ] **Step 3: Implement the selected recovery workspace**

Render side-by-side local and server panes with diff highlights, copy actions, editable local merge, and explicit resubmit. Keep the draft durable through reload; resubmit uses displayed server revision and a new operation ID.

- [ ] **Step 4: Verify accessibility and commit**

Test keyboard focus trap/return, labeled panes, live save/conflict status, copy feedback, and reduced-motion behavior.

```bash
git add apps/web/src/components apps/web/src/pages/WorkbenchPage.vue apps/web/src/stores
git commit -m "feat: add note history and conflict recovery"
```

### Task 13: Add Chrome E2E, Performance, and Load Evidence

**Files:**

- Modify: `playwright.config.ts`
- Create: `tests/e2e/editor.spec.ts`
- Create: `tests/e2e/conflict.spec.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `tests/e2e/security-rendering.spec.ts`
- Create: `tests/performance/editor.perf.spec.ts`
- Create: `tests/load/autosave-conflict.ts`
- Create: `docs/evidence/phase2/README.md`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/provenance.yml`

**Interfaces:**

- Produces: reproducible Phase 2 release evidence; consumes only public browser/API interfaces.

- [ ] **Step 1: Add failing end-to-end scenarios**

Cover all modes and built-ins, offline/online retry, reload draft recovery, two-tab takeover, `409` comparison/copy/manual merge/resubmit, soft-delete restore, checkpoint/version restore, and uniform tenant 404 behavior.

- [ ] **Step 2: Add Chrome accessibility/security evidence**

Run axe, keyboard-only workflows, visible focus, reduced motion, and the available screen-reader smoke. Prove hostile stored/IDB content does not execute, navigate, or initiate network requests.

- [ ] **Step 3: Add exact performance marks and gates**

Run on the SPEC reference profile: Linux x86-64, 4 vCPU, 8 GB RAM, API,
worker, PostgreSQL, and storage on one Docker Compose host, client/server on the
same test network, and five workspaces with 1,000 notes each. Record CPU, RAM,
image digest, data volume, browser/build SHA, and test version.

Playwright performance marks use the exact SPEC section 40 boundaries:

| Operation            | Warm-ups | Samples | Boundary                                                                         |         Gate |
| -------------------- | -------: | ------: | -------------------------------------------------------------------------------- | -----------: |
| 100 KB input         |      100 |   1,000 | `InputEvent` dispatch to the next animation frame containing the rendered change | p95 < 100 ms |
| Visual/Source switch |       10 |     100 | action trigger to target editor accepting input                                  |    p95 < 1 s |
| 1 MB open            |        5 |     100 | request dispatch to editor accepting input                                       |    p95 < 5 s |
| 1 MB save            |        5 |     100 | request dispatch to server acknowledgement and saved UI state                    |    p95 < 5 s |

Continuous typing records long tasks and fails on any task above 200 ms. API
sampling runs after a two-minute warm-up with at least 500 samples each for
`GET note` and `PUT autosave`, reporting p50/p95/p99. Gates are GET p95 below
500 ms and autosave p95 below one second. `GET search` and export remain outside
Phase 2 and are not claimed.

- [ ] **Step 4: Add five-user autosave/conflict load test**

Run a ten-minute Phase 2-specific profile: five authenticated users continuously
edit separate 100 KB notes and autosave every two seconds; every 30 seconds a
controlled same-note pair submits one shared base revision to exercise CAS.
Assert no data loss, revision regression, unexpected 5xx, partial operation,
duplicate job, or unauthorized content. Verify every acknowledged revision and
content hash through the API. This is not the deferred 30-minute workload and
must not be reported as satisfying P0-08.

- [ ] **Step 5: Run the complete gate and commit**

Build immutable Phase 2 artifacts in GitHub Actions and generate SLSA 1.2 Build
Level 1 provenance using GitHub artifact attestation. Record the workflow run,
subject digest, source commit, builder identity, and verification command in the
evidence directory. The compliance matrix links this evidence; if the hosting
environment cannot produce it, execution stops for an explicitly approved
exception rather than silently claiming SLSA compliance.

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:load:phase2
git diff --check main...HEAD
```

Expected: every command passes. Enable the complete `test:phase2` plus the
ten-minute load command in the final CI/evidence workflow. The evidence
directory explicitly records that Phase 2 does not claim P0-08's complete
30-minute workload or P0-14's cross-browser matrix.

```bash
git add playwright.config.ts tests docs/evidence .github/workflows/ci.yml .github/workflows/provenance.yml
git commit -m "test: verify phase2 editor workflows"
```

### Task 14: Final Security, Spec, and Outcome Verification

**Files:**

- Modify only if an approved reviewer finding requires a targeted fix.

**Interfaces:**

- Produces: an auditable merge decision; no new product interface.

- [ ] **Step 1: Run security review**

The security reviewer checks tenant predicates, CSRF/origin, cookie assertions, idempotency, transaction atomicity, IndexedDB account separation, render inertness, limits, logs, migrations, and compliance evidence. Critical or Important findings block completion.

- [ ] **Step 2: Run parallel Standards and Spec reviews**

Review the full `main...HEAD` diff against repository standards and the approved Phase 2 design. Fix complete finding sets one reviewer round at a time.

- [ ] **Step 3: Run a fresh outcome verifier**

The verifier independently reproduces migrations, focused tests, full gates, Chrome E2E, concurrency, hostile rendering, and performance evidence and returns only `CONFIRMED` or `REFUTED`.

- [ ] **Step 4: Present merge options**

Do not merge or push without the user's final choice. Preserve the feature branch for PR feedback unless the user explicitly chooses local merge and cleanup.
