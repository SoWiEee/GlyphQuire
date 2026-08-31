# Release P0 release checklist

The fourteen P0 gates from `docs/SPEC.md` §49 are release blockers. Rows may
be `blocked`, `in_progress`, or `passed`; a release decision requires all rows
to be passed exactly once.

| ID    | Area                       | Release blocker                                                            | Authoritative section         | Required evidence                           | Status  |
| ----- | -------------------------- | -------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------- | ------- |
| P0-01 | Deployment scope           | Hosted multi-tenant SaaS and five-user burst ceiling                       | SPEC §1                       | CI and Compose integration                  | blocked |
| P0-02 | Transactional persistence  | Atomic authorized autosave and durable enqueue                             | SPEC §18                      | Concurrent revision integration test        | blocked |
| P0-03 | Tenant isolation           | Every operation is workspace scoped server-side                            | SPEC §16                      | Cross-workspace rejection test              | blocked |
| P0-04 | Markdown/version history   | Self-describing format and monotonic conflict-safe history                 | SPEC §19; MARKDOWN_SPEC §47   | Golden and restore/conflict tests           | blocked |
| P0-05 | Security baseline          | ASVS L2, NIST 800-63B-4, and SLSA 1.2 L1                                   | SPEC §32                      | Compliance matrix and verification report   | blocked |
| P0-06 | Backup/data lifecycle      | Encrypted backup, retention, restore, and deletion lifecycle               | SPEC §33                      | Restore drill with hash verification        | blocked |
| P0-07 | CI/release/migration       | Immutable release identity and compatible migrations                       | SPEC §37                      | CI, deployment, and rollback evidence       | blocked |
| P0-08 | Small-workload performance | Reproducible four-vCPU/eight-GB five-user workload                         | SPEC §40                      | Load report with environment and digest     | blocked |
| P0-09 | Observability/runbooks     | Probes, alerts, and notification delivery within five minutes              | SPEC §30                      | Runbooks and alert test                     | blocked |
| P0-10 | Search consistency         | Freshness, authorization, dead-letter handling, and rebuild                | SPEC §20                      | Integration, dead-letter, and rebuild tests | blocked |
| P0-11 | First-party API            | Shared schemas, pagination, idempotency, and conditional mutations         | SPEC §24                      | API contract suite                          | blocked |
| P0-12 | Custom Blocks              | Workspace scope, immutable versions, fallback, and round-trip preservation | SPEC §11.3; MARKDOWN_SPEC §29 | Golden and integration tests                | blocked |
| P0-13 | Conflict recovery          | 409 preserves drafts and supports comparison/merge                         | SPEC §10.3                    | Conflict/reload E2E test                    | blocked |
| P0-14 | Browser/accessibility      | Latest-two browsers, WCAG 2.2 AA, and assistive technology smoke           | SPEC §41                      | axe, keyboard, and screen-reader evidence   | blocked |

The release gate is `infra/release/release-gate.sh` (also exposed as
`pnpm test:release`). It fails closed while any row or required evidence
is blocked and never emits `release-decision.json` without an immutable
candidate/publication SHA and explicit release-owner approval. Local WebKit
diagnostics, mocked browser runs, and placeholder screen-reader files do not
count as P0 evidence.
