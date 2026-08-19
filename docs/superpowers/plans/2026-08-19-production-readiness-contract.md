# Production Readiness Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revise the two authoritative GlyphQuire specifications so the first officially hosted production release has explicit P0 blockers, P1 follow-up scope, normative data invariants, and objective acceptance evidence.

**Architecture:** Keep detailed behavior in the existing subject chapters and add one consolidated Production Readiness Contract near Definition of Done. `docs/MARKDOWN_SPEC.md` exclusively owns persisted Markdown-format semantics; `docs/SPEC.md` owns product, tenancy, runtime, release, and operational semantics. Cross-references connect these sources without duplicating full requirements.

**Tech Stack:** Markdown specifications, TypeScript interface examples, PostgreSQL, Graphile Worker, GitHub Actions, Docker, Playwright, axe.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-08-19-production-readiness-contract-design.md`.
- P0 blocks the first official production release; P1 is non-blocking and is not a delivery commitment.
- The typical initial workload is one active user working on a personal notebook; officially hosted, multi-tenant SaaS supports a burst ceiling of five concurrent users.
- P0 does not promise an availability SLA, high availability, multi-region failover, or operation above the stated workload.
- Markdown remains the only authoritative document state.
- General security controls are referenced by fixed external baselines; do not copy those control catalogs into `docs/SPEC.md`.
- GlyphQuire-specific trust boundaries and enforcement invariants remain directly normative.
- Preserve existing architecture and technology decisions unless the approved design explicitly changes them.
- Do not create application code, CI workflows, runbooks, or test fixtures in this documentation-only change.

## Execution Ownership and Stop Conditions

- Exactly one writer owns both `docs/SPEC.md` and `docs/MARKDOWN_SPEC.md` for Tasks 1–4. Tasks run sequentially in numeric order; no parallel writer may edit either file.
- Before Task 1, the orchestrator records `READINESS_BASE_SHA="$(git rev-parse HEAD)"` and the complete output of `git status --short` in the execution log.
- Stop before editing if `docs/SPEC.md` or `docs/MARKDOWN_SPEC.md` has a pre-existing worktree change. The parent resolves ownership rather than overwriting it.
- Stop before committing when any task verification command fails or produces an unexpected match/count.
- The plan and approved design must be committed before implementation starts. They are not part of the Tasks 1–4 implementation diff.
- At completion, compare against the recorded literal base SHA; do not assume a fixed number of commits or claim unrelated pre-existing paths are clean.

---

### Task 1: Make Markdown Versions and Custom Blocks Self-Describing

**Files:**
- Modify: `docs/MARKDOWN_SPEC.md:1032`
- Modify: `docs/MARKDOWN_SPEC.md:1482`
- Modify: `docs/MARKDOWN_SPEC.md:1599`
- Modify: `docs/MARKDOWN_SPEC.md:1693`
- Modify: `docs/MARKDOWN_SPEC.md:1748`

**Interfaces:**
- Consumes: the approved `glyphquire-spec` frontmatter and workspace-scoped immutable Custom Block decisions.
- Produces: the normative persisted-format contract that `docs/SPEC.md` references during import, export, parsing, and migration.

- [ ] **Step 1: Capture the conflicting baseline**

Run:

```bash
rg -n "Markdown itself does not require|Version comes from|User custom blocks record|Declarative Custom Blocks|Custom Block Constraints" docs/MARKDOWN_SPEC.md
```

Expected: the command finds the versionless v0.1 rule in §47 and the current registry/version rules in §§29, 30, and 49.

- [ ] **Step 2: Replace §47 with the self-describing canonical format**

Specify all of the following as normative text:

````md
## 47. Specification Version

Canonical GlyphQuire Markdown MUST include the reserved YAML frontmatter field `glyphquire-spec` with a positive integer version.

```yaml
---
glyphquire-spec: 1
---
```

The parser MUST expose the version to the migration layer. Exported standalone Markdown and bundles MUST retain it. Versionless input is legacy input: import MUST follow an explicit legacy policy and MUST NOT guess a version before a destructive migration. Database metadata MAY duplicate the value for indexing, but a mismatch is an error and Markdown remains authoritative.
````

Retain deterministic migration, source preservation, diagnostics, fixtures, and pre-migration snapshot requirements in §48. In §49, state that the notebook spec version deterministically selects built-in definition versions.

- [ ] **Step 3: Close the Custom Block definition lifecycle**

In §§29, 30, and 49, specify:

```md
- Declarative definitions are scoped to exactly one workspace.
- A published definition version is immutable.
- A new behavior or schema requires a new positive integer definition version.
- Built-in names remain reserved and cannot be shadowed.
- Disabled, deleted, unknown, or unavailable definitions render an unsupported placeholder while preserving the original directive for round-trip serialization.
- Cross-workspace definition resolution is invalid.
- Executable third-party blocks are outside P0.
```

Keep workspace authorization enforcement in `docs/SPEC.md`; this file owns only format identity, resolution, and preservation semantics.

- [ ] **Step 4: Reconcile canonical examples, conformance, and fixtures**

Add `glyphquire-spec: 1` frontmatter to the canonical Example Document in §53. Update parser/serializer conformance and required fixture categories so every canonical valid-document fixture includes the marker. Versionless examples and fixtures must be explicitly labeled `legacy` or `invalid`; they must never appear as canonical valid documents.

Require conformance tests to cover a missing marker, a non-positive/non-integer marker, an unsupported future marker, and a database/Markdown version mismatch.

- [ ] **Step 5: Verify the Markdown-format contract**

Run:

```bash
rg -n "glyphquire-spec|legacy input|MUST NOT guess|published definition version|unsupported placeholder|Cross-workspace|outside P0|unsupported future|version mismatch" docs/MARKDOWN_SPEC.md
rg -n "Markdown itself does not require visible frontmatter|Version comes from note metadata/database/import context" docs/MARKDOWN_SPEC.md
git diff --check -- docs/MARKDOWN_SPEC.md
```

Expected: the positive search finds every required phrase; the superseded-rule search returns no matches; the §53 canonical example begins with `glyphquire-spec: 1`; `git diff --check` exits 0.

- [ ] **Step 6: Commit the format contract**

```bash
git add docs/MARKDOWN_SPEC.md
git commit -m "docs: define versioned markdown lifecycle"
```

---

### Task 2: Close Data, Tenant, Search, and API Invariants

**Files:**
- Modify: `docs/SPEC.md:308`
- Modify: `docs/SPEC.md:479`
- Modify: `docs/SPEC.md:582`
- Modify: `docs/SPEC.md:825`
- Modify: `docs/SPEC.md:916`
- Modify: `docs/SPEC.md:943`
- Modify: `docs/SPEC.md:1011`
- Modify: `docs/SPEC.md:1192`
- Modify: `docs/SPEC.md:1291`
- Modify: `docs/SPEC.md:1739`

**Interfaces:**
- Consumes: Task 1’s `glyphquire-spec` and Custom Block format contract.
- Produces: authoritative application invariants later summarized by the Production Readiness Contract.

- [ ] **Step 1: Replace mutation-only authorization with tenant-wide enforcement**

Replace “所有 mutation API 必須 server-side authorization” with normative coverage for reads, lists, searches, mutations, restores, asset resolution, share access, and worker execution. Add these invariants:

```md
- Every note, asset, theme, share link, search record, and job belongs to exactly one workspace.
- Every server and worker operation derives workspace scope from trusted server-side context and applies it to the resource query.
- A resource owner MUST be a current member of its workspace; ownership MUST be transferred before that member leaves.
- Cross-workspace asset and Custom Block references MUST be rejected.
```

Keep `authorize(actor, action, resource)` as the single policy entry point and make deny-by-default behavior explicit.

- [ ] **Step 2: Make autosave transactional and jobs revision-aware**

In §§17.3, 18.2, 18.3, and 27.3, state that authorization, document validation, revision compare-and-swap, note update, revision increment, optional snapshot, and durable Graphile Worker enqueue occur in one PostgreSQL transaction.

Define the job identity exactly as:

```ts
type NoteOperationIdentity = {
  noteId: string;
  revision: number;
  operation: string;
};
```

Require handlers to be idempotent by this identity and forbid a job for an older revision from replacing derived state for a newer revision.

- [ ] **Step 3: Align the Document Engine interface and history semantics**

Change the canonical parser interface so version does not arrive through an optional out-of-band argument:

```ts
export interface DocumentEngine {
  parse(markdown: string): ParseResult;
  importLegacy(markdown: string, assumedVersion: number): ParseResult;
  validate(document: DocumentNode): ValidationResult;
  serialize(document: DocumentNode): string;
  migrate(markdown: string, from: number, to: number): MigrationResult;
  extractText(document: DocumentNode): string;
}
```

`parse` reads `glyphquire-spec` from canonical Markdown. Only the explicitly named `importLegacy` accepts a caller-selected version, and it must preserve the original input in its result/diagnostics.

In §§17.3, 19, 22, and 39, require `baseRevision` for import, restore, and document migration. A mismatch returns `409 REVISION_CONFLICT`. A success creates a new monotonically increasing revision and records actor, timestamp, and reason; it never rewinds or overwrites history. A failure preserves the original Markdown. Reference `docs/MARKDOWN_SPEC.md` for marker validation and legacy import behavior.

- [ ] **Step 4: Define search freshness and recovery**

In §§20, 27, and 30, require:

```md
- Saved content and revision history are immediately authoritative.
- Under the approved P0 benchmark environment and workload, every successfully saved revision becomes searchable within 60 seconds; outside that profile this is an engineering target rather than an external SLA.
- Results exclude unauthorized, deleted, and cross-workspace content at query time.
- Failed indexing retries and then enters dead-letter state with an operator alert.
- An operator can rebuild one note or one workspace.
```

- [ ] **Step 5: Finish the first-party API contract**

In §§24–26, define `/api/v1` as first-party-only P0 scope. Require shared request/response schemas, cursor pagination, deterministic ordering, idempotency keys for retriable create/upload/export operations, revision or equivalent conditional mutations, and backward-compatible error codes. State that a breaking contract requires a new API version or explicit migration. Move public API credentials and long-term third-party SDK compatibility to P1.

- [ ] **Step 6: Define editor conflict recovery and Custom Block enforcement**

In §§10.3 and 11.3, require that `409` never overwrites server content, the client retains an unsent local draft across reload/crash, and the UI supports comparison, copying, or manual merge before resubmission. Reference `docs/MARKDOWN_SPEC.md` for immutable definition versions and unsupported placeholders; require workspace-scoped resolution server-side.

- [ ] **Step 7: Verify data and interface invariants**

Run:

```bash
rg -n "parse\(markdown: string\)|importLegacy|deny-by-default|exactly one workspace|PostgreSQL transaction|NoteOperationIdentity|older revision|REVISION_CONFLICT|60 seconds|rebuild one|cursor pagination|idempotency keys|local draft" docs/SPEC.md
rg -n "parse\(markdown: string, version\?" docs/SPEC.md
rg -n "所有 mutation API 必須" docs/SPEC.md
git diff --check -- docs/SPEC.md
```

Expected: the first search finds every new invariant; both superseded-interface/authorization searches return no matches; whitespace validation exits 0.

- [ ] **Step 8: Commit the data contract**

```bash
git add docs/SPEC.md
git commit -m "docs: close production data invariants"
```

---

### Task 3: Define Security, Recovery, Release, and Operational Evidence

**Files:**
- Modify: `docs/SPEC.md:809`
- Modify: `docs/SPEC.md:1329`
- Modify: `docs/SPEC.md:1426`
- Modify: `docs/SPEC.md:1486`
- Modify: `docs/SPEC.md:1702`
- Modify: `docs/SPEC.md:1719`
- Modify: `docs/SPEC.md:1769`
- Modify: `docs/SPEC.md:1784`

**Interfaces:**
- Consumes: the approved external security baseline and P0 acceptance decisions.
- Produces: subject-level operational requirements and named release evidence for Task 4’s checklist.

- [ ] **Step 1: Replace implementation-defined security with versioned baselines**

In §§15 and 32, retain GlyphQuire-specific trust boundaries and add direct links to:

```text
https://owasp.org/www-project-application-security-verification-standard/ — OWASP ASVS 5.0.0 Level 2
https://pages.nist.gov/800-63-4/sp800-63b/ — NIST SP 800-63B-4
https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
https://html.spec.whatwg.org/ — WHATWG HTML
https://www.w3.org/TR/CSP3/ — W3C CSP Level 3
https://slsa.dev/spec/v1.2/ — SLSA 1.2 Build Level 1
```

Require a compliance matrix with `applicable`, `implemented`, `evidence`, and `documented exception` states. An exception includes rationale, risk, compensating control, and approver. Release evidence includes applicable automated tests/scans and manual verification. Do not copy the external control catalogs.

Pin ASVS, NIST, and SLSA by the versions above. For each living OWASP Cheat Sheet, WHATWG HTML, or CSP page, record the direct URL, `Reviewed: 2026-08-19`, and an `Upstream commit:` field containing the full 40-character lowercase SHA retrieved from the official repository during implementation. A later baseline refresh must update the review date/commit and rerun the compliance review.

Retrieve the reviewed upstream revisions with:

```bash
git ls-remote https://github.com/OWASP/CheatSheetSeries.git HEAD
git ls-remote https://github.com/whatwg/html.git HEAD
git ls-remote https://github.com/w3c/webappsec-csp.git HEAD
```

Expected: each command returns one 40-character SHA followed by `HEAD`. Use the corresponding SHA for the living documents from that repository.

- [ ] **Step 2: Make backup, restore, export, and deletion measurable**

In §§21, 22, 28, and 33, require encrypted PostgreSQL and Object Storage backups at least daily, 30-day retention, an extra backup before destructive migration, monthly full restore drills, relationship/content-hash verification, retained drill results, and a maximum accepted data-loss window of 24 hours.

Specify export of Markdown, assets, and required metadata; 30-day note recovery followed by permanent deletion; confirmed account/workspace deletion of primary data, versions, assets, search records, share links, and pending jobs within 30 days; immediate share-link revocation; backup expiry through retention; and 90-day audit/security log retention without document bodies, credentials, or secrets.

- [ ] **Step 3: Make CI, releases, and schema changes reproducible**

In §§37 and 38, require GitHub Actions. PR gates are typecheck, lint, unit, integration, golden, and build. Main additionally runs core Playwright and security baseline checks.

Define a release by Git tag, immutable Docker image digest, database migration version, and document migration version. Require manual production approval, health/readiness checks, previous-image rollback, and expand/contract schema compatibility. Replace the current unconditional “deploy migration → deploy app” ordering with compatibility-window language. State that data recovery uses forward repair plus preserved source/snapshots rather than destructive schema rollback.

- [ ] **Step 4: Set the reproducible small-workload performance gate**

In §40, define the benchmark environment as Linux x86-64, 4 vCPU, 8 GB RAM, with API, Worker, PostgreSQL, and Object Storage under Docker Compose on one host; clients use the same test network. Seed five workspaces with 1,000 notes each and record CPU, RAM, image digest, data volume, and test version.

Define the common case as one active user and the burst case as five. Require 100 KB input-to-render p95 below 100 ms, Visual/Source switch p95 below one second, and 1 MB open/save/export p95 below five seconds per operation. Continuous typing allows no main-thread task over 200 ms. Full parse/validation above 100 KB uses a Web Worker or interruptible processing.

Define the 30-minute burst workload: each user edits one 100 KB note, autosaves every two seconds, searches every ten seconds, and uploads one 5 MB asset every five minutes. Permit no data loss, revision regression, unexpected `5xx`, or dead-letter job. After traffic stops, the search/index queue drains within 60 seconds. Read back every successful autosave revision and verify the expected content hash.

Compute latency separately for `GET note`, `PUT autosave`, and `GET search`, using at least 500 samples per route after a two-minute warm-up. Report p50/p95/p99. `GET note` and `GET search` require p95 below 500 ms; `PUT autosave` requires p95 below one second. Any timeout, unexpected `5xx`, or integrity failure fails the gate. These are release gates, not an external SLA.

- [ ] **Step 5: Set minimum observability and operational artifacts**

In §§28–30, require structured logs, request/job correlation identifiers, error tracking, and health/readiness checks. Notify after three consecutive health/readiness failures or five continuous minutes; immediately for any backup failure, dead-letter job, or oldest queue job above five minutes; at 80% database/disk use as warning and 90% as critical. Deliver production notification to the configured operator channel within five minutes after a condition is met and send recovery notification when cleared. Require deploy, rollback, restore, and queue-recovery runbooks. Mark formal on-call, burn-rate alerts, and distributed tracing P1.

- [ ] **Step 6: Set browser and accessibility evidence**

In §§36.5 and 41, require the latest two stable Chrome, Firefox, Safari, and Edge releases; full desktop editing; mobile reading and basic management; WCAG 2.2 AA for built-in UI; axe in CI; keyboard-only core flows; focus and reduced-motion checks; and one VoiceOver or NVDA core-flow smoke test. Mark a complete mobile visual editor P1.

- [ ] **Step 7: Verify operational requirements and links**

Run:

```bash
rg -n "ASVS 5.0.0|800-63B-4|SLSA 1.2|Reviewed: 2026-08-19|Upstream commit: [0-9a-f]{40}|compliance matrix|30-day|monthly full restore|24 hours|GitHub Actions|image digest|expand/contract|4 vCPU|500 samples|content hash|200 ms|three consecutive|80%|WCAG 2.2 AA|VoiceOver|NVDA" docs/SPEC.md
rg -n "真正 production SLO|deploy migration.*deploy app|Password policy.*implementation" docs/SPEC.md
git diff --check -- docs/SPEC.md
```

Expected: all approved evidence terms are found; the three superseded statements are absent; whitespace validation exits 0.

- [ ] **Step 8: Commit operational requirements**

```bash
git add docs/SPEC.md
git commit -m "docs: define production release evidence"
```

---

### Task 4: Add the Central Production Readiness Contract

**Files:**
- Modify: `docs/SPEC.md:3`
- Modify: `docs/SPEC.md:8`
- Modify: `docs/SPEC.md:16`
- Modify: `docs/SPEC.md:1486`
- Modify: `docs/SPEC.md:1501`
- Modify: `docs/SPEC.md:1566`
- Modify: `docs/SPEC.md:1814`
- Modify: `docs/SPEC.md:2086`

**Interfaces:**
- Consumes: the authoritative subject requirements from Tasks 1–3.
- Produces: one release checklist that classifies P0/P1 without duplicating subject-level prose.

- [ ] **Step 1: Reconcile the deployment source of truth**

Update the header, Purpose, Product Goals, Backups, Local Deployment, Cloudflare strategy, product scope, and roadmap so they agree on this model:

```md
- P0 production is the officially hosted, multi-tenant SaaS.
- The typical workload is one active personal-notebook user with a five-concurrent-user burst ceiling.
- Docker Compose remains the supported local development and full-stack preview path.
- Self-hosted production support is P1, not a P0 release promise.
- Cloudflare portability remains an architectural constraint, not a required P0 runtime.
```

Replace the header’s `Deployment target: Local-first / self-hosted` and the Purpose/Product Goal claims that the first production stage is self-hosted. Change §33’s `Local production/self-hosted 必須支援` wording to the hosted P0 backup contract while preserving local backup documentation as useful development/operator guidance.

- [ ] **Step 2: Insert the priority definitions near Definition of Done**

After the existing Definition of Done, insert `## 49. Production Readiness Contract` and renumber the following top-level sections. Define P0 as release-blocking with observable evidence and P1 as non-blocking and not committed without a later approved plan. State the hosted multi-tenant, maximum-five-user workload and the absence of availability SLA, HA, and multi-region promises.

- [ ] **Step 3: Add a P0 evidence table**

Create exactly 14 rows identified `P0-01` through `P0-14`, with columns `ID`, `Area`, `Release blocker`, `Authoritative section`, and `Required evidence`:

```text
Deployment scope; transactional persistence; tenant isolation; Markdown/version history; security baseline; backup/data lifecycle; CI/release/migration; small-workload performance; observability/runbooks; search consistency; first-party API; Custom Blocks; conflict recovery; browser/accessibility.
```

Each row links to the detailed subject section and names concrete evidence such as integration test, compliance matrix, restore report, CI run, load report, runbook, E2E test, or accessibility report. Do not repeat the full normative behavior in the table.

- [ ] **Step 4: Add the complete P1 list**

Create exactly 12 bullets identified `P1-01` through `P1-12`: self-hosted production support; HA; multi-region; formal availability SLO; distributed tracing; complete dashboards; formal incident severity/on-call/escalation; public API and third-party tokens/SDKs; complete mobile visual editing; real-time collaboration/CRDT/automatic three-way merge; executable third-party plugins; and scaling beyond five concurrent users.

- [ ] **Step 5: Reconcile scope, milestones, and Definition of Done**

Update §§43–45, Phase 6, and Definition of Done so they reference the Contract. Remove wording that implies a P1 item is a P0 commitment. Keep implementation milestones as sequencing guidance rather than release approval. Ensure the existing P0 product feature scope does not contradict the production-readiness P0 meaning; explicitly distinguish “product scope” from “release blocker priority.”

- [ ] **Step 6: Verify centralized authority and section structure**

Run:

```bash
rg -n '^## [0-9]+\.' docs/SPEC.md
rg -n "Production Readiness Contract|Release blocker|Required evidence|not a delivery commitment|five concurrent|availability SLA|self-hosted production|multi-region|CRDT|executable third-party" docs/SPEC.md
test "$(rg -c '^\| P0-[0-9]{2} \|' docs/SPEC.md)" -eq 14
test "$(rg -c '^- P1-[0-9]{2}:' docs/SPEC.md)" -eq 12
rg -n "Deployment target: Local-first / self-hosted|第一階段以本地部署與 self-hosted 為優先|第一版可完整 self-host|Local production/self-hosted 必須支援" docs/SPEC.md
git diff --check -- docs/SPEC.md docs/MARKDOWN_SPEC.md
```

Expected: top-level numbering is sequential; both P0/P1 count commands exit 0; the superseded-deployment search returns no matches; whitespace validation exits 0.

- [ ] **Step 7: Commit the centralized contract**

```bash
git add docs/SPEC.md
git commit -m "docs: add production readiness contract"
```

---

### Task 5: Cross-Spec Consistency Verification

**Files:**
- Verify: `docs/SPEC.md`
- Verify: `docs/MARKDOWN_SPEC.md`
- Reference: `docs/superpowers/specs/2026-08-19-production-readiness-contract-design.md`

**Interfaces:**
- Consumes: the integrated specification changes from Tasks 1–4.
- Produces: evidence that the completed specifications match every approved decision without contradictory authority.

- [ ] **Step 1: Run superseded-language checks**

Run:

```bash
rg -n "Markdown itself does not require visible frontmatter|所有 mutation API 必須|真正 production SLO 應|Password policy 與 account enumeration 防護由 security implementation 詳訂|deploy migration.*deploy app|Deployment target: Local-first / self-hosted|第一階段以本地部署與 self-hosted 為優先|第一版可完整 self-host|Local production/self-hosted 必須支援|parse\(markdown: string, version\?" docs/SPEC.md docs/MARKDOWN_SPEC.md
```

Expected: no matches.

- [ ] **Step 2: Run approved-decision coverage checks**

Run:

```bash
rg -n "glyphquire-spec|PostgreSQL transaction|exactly one workspace|60 seconds|ASVS 5.0.0|30-day|GitHub Actions|4 vCPU|500 samples|three consecutive|WCAG 2.2 AA|Production Readiness Contract" docs/SPEC.md docs/MARKDOWN_SPEC.md
test "$(rg -c '^\| P0-[0-9]{2} \|' docs/SPEC.md)" -eq 14
test "$(rg -c '^- P1-[0-9]{2}:' docs/SPEC.md)" -eq 12
```

Expected: every term is present in its authoritative file; both count commands exit 0; the Contract contains exactly one summary row for each approved P0 group and all 12 approved P1 items.

- [ ] **Step 3: Review the authority inventory**

For each stable ID, record exactly one detailed authoritative section and one Contract summary row in the verification report:

```text
P0-01 deployment scope
P0-02 transactional persistence
P0-03 tenant isolation
P0-04 Markdown/version history
P0-05 security baseline
P0-06 backup/data lifecycle
P0-07 CI/release/migration
P0-08 small-workload performance
P0-09 observability/runbooks
P0-10 search consistency
P0-11 first-party API
P0-12 Custom Blocks
P0-13 conflict recovery
P0-14 browser/accessibility
```

Reject the result if a Contract row contains full duplicated normative prose instead of a section reference, if two subject sections claim to be the authority for the same invariant, or if a referenced section does not exist.

- [ ] **Step 4: Validate external reference reachability**

Run:

```bash
curl -L --fail --silent --show-error --output /dev/null https://owasp.org/www-project-application-security-verification-standard/
curl -L --fail --silent --show-error --output /dev/null https://pages.nist.gov/800-63-4/sp800-63b/
curl -L --fail --silent --show-error --output /dev/null https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
curl -L --fail --silent --show-error --output /dev/null https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
curl -L --fail --silent --show-error --output /dev/null https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
curl -L --fail --silent --show-error --output /dev/null https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
curl -L --fail --silent --show-error --output /dev/null https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
curl -L --fail --silent --show-error --output /dev/null https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
curl -L --fail --silent --show-error --output /dev/null https://html.spec.whatwg.org/
curl -L --fail --silent --show-error --output /dev/null https://www.w3.org/TR/CSP3/
curl -L --fail --silent --show-error --output /dev/null https://slsa.dev/spec/v1.2/
```

Expected: all commands exit 0.

- [ ] **Step 5: Review the integrated diff and whitespace**

Run:

```bash
git diff --check "$READINESS_BASE_SHA"..HEAD
git diff --stat "$READINESS_BASE_SHA"..HEAD
git diff --name-only "$READINESS_BASE_SHA"..HEAD
git status --short
```

Expected: no whitespace errors; the name-only output contains exactly `docs/SPEC.md` and `docs/MARKDOWN_SPEC.md`; neither authoritative file has an uncommitted change. Any unrelated pre-existing status recorded at execution start is reported unchanged rather than claimed clean.

- [ ] **Step 6: Request independent outcome verification**

Provide the verifier with the approved design path, the four implementation commits, the exact commands above, and the requirement to return `CONFIRMED` only if P0/P1 authority is unambiguous and every decision has direct evidence.
