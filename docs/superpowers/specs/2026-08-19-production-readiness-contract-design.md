# Production Readiness Contract Design

## Outcome

Revise `docs/SPEC.md` so it serves as an enforceable production contract for the initial officially hosted, multi-tenant GlyphQuire SaaS. The revision will centralize release-blocking P0 requirements and post-launch P1 improvements in a new Production Readiness Contract, while adding only the necessary normative details and cross-references to existing subject chapters.

The initial production workload is at most five concurrent users. P0 therefore emphasizes data integrity, tenant isolation, recoverability, secure implementation evidence, and repeatable release operations rather than high availability or large-scale capacity.

## Priority Semantics

- **P0** requirements block the first official production release. Every P0 item requires observable acceptance evidence; unsupported claims such as “considered” or “supported” do not pass.
- **P1** requirements do not block the first release, but the P0 architecture must leave a compatible evolution path. P1 is not a delivery commitment without a later approved plan.
- The Production Readiness Contract is the consolidated release checklist. Existing chapters remain the normative source for detailed subsystem behavior and link back to the contract.

## P0 Scope

P0 covers:

1. Officially hosted, multi-tenant SaaS deployment.
2. Transactional autosave, revision integrity, and idempotent background jobs.
3. Workspace tenant isolation across all resources and execution paths.
4. Self-describing Markdown versions and deterministic import, restore, and migration behavior.
5. Versioned external security baselines and auditable compliance evidence.
6. Backup, restore, retention, export, and deletion behavior.
7. CI gates, immutable releases, controlled deployment, compatible migrations, and rollback.
8. Reproducible performance acceptance for five concurrent users.
9. Minimum viable observability, alerts, and operational runbooks.
10. Search-index freshness, authorization, dead-letter handling, and rebuild operations.
11. A versioned first-party API contract.
12. Declarative Custom Block version and lifecycle behavior.
13. Optimistic editing conflicts and local draft recovery.
14. Supported browsers and WCAG 2.2 AA verification.

P0 explicitly does not promise an availability SLA, active multi-region failover, or operation beyond the stated workload.

## P1 Scope

P1 contains self-hosted production support; high availability; multi-region operation; formal availability SLOs; distributed tracing; complete operational dashboards; formal incident severity, on-call, and escalation processes; public APIs and long-lived third-party SDKs; a complete mobile visual editor; real-time collaboration, CRDT, and automatic three-way merge; executable third-party plugins; and scaling beyond five concurrent users.

## Data Integrity and Tenant Invariants

Autosave must perform authorization, revision compare-and-swap, note update, revision increment, optional version snapshot, and durable Graphile Worker enqueue in one PostgreSQL transaction. A job uses `noteId + revision + operation` as its idempotency identity. A stale job must never replace derived state produced for a newer revision.

Every note, asset, theme, share link, search record, and background job belongs to exactly one workspace. Every read, list, search, mutation, asset resolution, restore, and worker operation applies workspace scope server-side. A resource owner must be a current workspace member; ownership must be transferred before that member leaves. Cross-workspace asset and Custom Block references are prohibited.

Canonical Markdown contains a reserved YAML frontmatter field:

```yaml
---
glyphquire-spec: 1
---
```

Versionless input is handled only through an explicit legacy-import policy. The system must not guess a version and perform a destructive migration. Import, restore, and document migration require `baseRevision`; conflict returns `409`. A successful operation creates a new monotonically increasing revision with actor, timestamp, and reason. It never rewinds or overwrites history. Failure preserves the original Markdown.

Search is eventually consistent. Under the P0 workload, a saved revision must normally become searchable within 60 seconds. Failed jobs retry, then enter a dead-letter state and alert an operator. Results must exclude unauthorized, deleted, and cross-workspace content. Operators can rebuild one note or one workspace.

Declarative Custom Block definitions are workspace-scoped, immutable after publication, and versioned. Disabling or deleting a definition leaves source Markdown round-trippable and displays an unsupported placeholder. Executable third-party blocks are not P0.

P0 editing uses optimistic concurrency rather than CRDT. A `409` must not overwrite server content. The client preserves the unsent local draft and offers comparison, copying, or manual merge before resubmission. A browser reload or crash must not silently discard that draft.

## Security Baseline

`SPEC.md` will reference rather than reproduce general security controls. P0 implementation must comply with applicable requirements from:

- OWASP ASVS 5.0.0 Level 2;
- NIST SP 800-63B-4 for authentication and session management;
- the OWASP Authentication, Session Management, CSRF, XSS Prevention, SSRF Prevention, and File Upload Cheat Sheets;
- WHATWG HTML and W3C Content Security Policy specifications for iframe sandboxing, `postMessage`, and CSP; and
- SLSA 1.2 Build Level 1 for release provenance.

Referenced versions are fixed until explicitly reviewed. A security compliance matrix records each relevant requirement as applicable, implemented with evidence, or excepted. An exception records rationale, risk, compensating control, and approver. Release evidence includes applicable automated tests and scans plus required manual verification. GlyphQuire-specific trust boundaries—workspace isolation, sandbox origin, untrusted Markdown and UGC, and executable runtime semantics—remain directly specified in `SPEC.md`.

## Recoverability and Data Lifecycle

PostgreSQL and Object Storage receive encrypted backups at least daily, retained for 30 days. A destructive migration requires an additional pre-migration backup. A full restore drill runs monthly and verifies notes, revisions, asset relationships, and content hashes; results are retained. The accepted maximum data-loss window is 24 hours. No availability SLA is promised.

Users can export Markdown, assets, and required metadata. Deleted notes remain recoverable for 30 days and are then permanently deleted. Confirmed workspace or account deletion removes primary records, versions, assets, search entries, share links, and pending jobs within 30 days. Revoked share links stop working immediately. Backup copies expire through the 30-day retention cycle. Audit and security logs are retained for 90 days and must not contain document bodies, credentials, or secrets.

## Release and Migration Contract

GitHub Actions is the required CI platform. Pull requests run type checking, linting, unit tests, integration tests, document golden tests, and the build. Main additionally runs core Playwright flows and security baseline checks.

A production release is identified by a Git tag, immutable Docker image digest, and database/document migration versions. Production deployment requires manual approval. The previous image remains deployable, and failed health checks trigger application rollback. Database changes use expand/contract compatibility so old and new application versions can run during deployment. Data migration recovery relies on forward repair and preserved source/snapshots rather than assuming destructive schema rollback is safe.

## Performance and Operations Acceptance

Release testing uses five concurrent users. A 100 KB Markdown document must remain interactively usable; a 1 MB document must open, save, and export. In the representative test environment, ordinary API requests have p95 latency below 500 ms and autosave server responses below one second. A 30-minute workload must not accumulate errors or an unbounded queue backlog. Parser work must not cause prolonged UI-thread blocking. These are release gates, not external SLAs.

P0 operations include structured logs, request/job correlation identifiers, error tracking, health and readiness checks, and notifications for sustained API failure, backup failure, dead-letter jobs, and database or disk capacity. The repository provides deploy, rollback, restore, and queue-recovery runbooks. Formal on-call, burn-rate alerting, and distributed tracing are P1.

## API, Browser, and Accessibility Contract

P0 supports only the first-party `/api/v1` interface. Every request and response has a shared schema. List and search operations use cursor pagination and deterministic ordering. Retriable create, upload, and export operations accept idempotency keys. Mutations use revision or equivalent conditional requests. Error codes remain backward compatible; a breaking contract requires a new API version or explicit migration. Public API credentials and long-term third-party SDK compatibility are P1.

P0 supports the latest two stable releases of Chrome, Firefox, Safari, and Edge. Desktop receives full editing support. Mobile must support reading and basic management; a complete mobile visual editor is P1. Built-in UI targets WCAG 2.2 AA and is verified through axe in CI, keyboard-only core flows, visible focus and reduced-motion checks, and a core-flow smoke test with at least one of VoiceOver or NVDA.

## SPEC.md Integration

The implementation will:

1. Add a consolidated Production Readiness Contract near the existing Definition of Done and milestone material.
2. Update the Autosave, Authorization, Persistence, Search, API, Background Jobs, Security, Backups, Testing, Quality Gates, Database Migrations, Document Migrations, Performance, Accessibility, and scope sections with the approved normative details.
3. Update `docs/MARKDOWN_SPEC.md` only where the self-describing `glyphquire-spec` field and Custom Block version semantics are normative Markdown-format behavior.
4. Remove or reword contradictions, especially the absence of a Markdown version marker, mutation-only authorization wording, undefined production SLO language, and migration ordering that does not guarantee rolling compatibility.
5. Preserve the current architecture and technology choices unless a change is required by an approved invariant above.

## Verification

The document revision is complete when every approved decision appears exactly once as the authoritative requirement, relevant chapters cross-reference it without contradiction, all P0 items have named evidence, P1 is clearly non-blocking, security references are versioned and linkable, and searches for the superseded statements show that they have been removed or explicitly qualified.
