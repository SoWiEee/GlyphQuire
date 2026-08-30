# Phase 6 Production Hardening Design

## Goal

Make GlyphQuire releasable as the scoped P0 hosted SaaS: every release gate is
observable, reproducible, reversible, and backed by sanitized evidence. Phase6
does not expand product scope; P1 items remain deferred.

## Scope

### 1. Reproducible release pipeline

Pin Node/pnpm/dependency inputs, run typecheck → oxlint → oxfmt → build → tests,
run migrations before database-backed tests, publish immutable build/image
digests, and verify migration expand/contract plus rollback behavior. A missing
secret, migration URL, artifact, or evidence file fails closed.

### 2. Deployment and recovery

Provide a tested deployment, rollback, queue-recovery, backup, restore, and
pre-destructive runbook. Compose and hosted deployment must perform database,
object-storage, role, and schema preflight before accepting traffic. Backups use
the existing encrypted 30-day policy; restore drills run against isolated
database and bucket targets and retain relationship/hash evidence only.

### 3. Operations and security evidence

Finalize structured request/job logs, health/readiness probes, queue age and
dead-letter alerts, backup-failure alerts, and recovery notifications. Alert
delivery must be demonstrated through the configured operator channel within
five minutes. Logs and evidence must exclude credentials, cookies, tokens,
presigned URLs, Markdown bodies, archive contents, and provider diagnostics.

### 4. P0 workload and browser evidence

Run the exact five-user, 30-minute workload on the specified 4-vCPU/8-GB
environment, recording p50/p95/p99, queue drain, revision/hash integrity, and
zero unexpected 5xx/dead letters. Run the latest-two Chrome, Firefox, Safari,
and Edge matrix, axe/WCAG 2.2 AA checks, keyboard flows, and one VoiceOver or
NVDA core-flow smoke test. Evidence records versions, timestamps, environment
digest, and immutable artifact links.

### 5. Release decision

Assemble one P0 checklist mapping each gate to its command, artifact, and
owner. The release candidate is accepted only when all P0 rows are green and
the rollback/recovery rehearsal succeeds. P1-01 through P1-12 (HA, multi-region,
formal SLOs, tracing, complete dashboards, on-call process, public SDKs,
complete mobile editing, realtime collaboration, plugins, and scaling beyond
five users) remain explicitly non-blocking and out of scope.

## Architecture and flow

```text
commit
  → CI quality gates + frozen install
  → immutable build/image + migration verification
  → isolated deploy smoke (PostgreSQL + object storage + worker)
  → browser/accessibility + five-user performance evidence
  → backup/restore + rollback rehearsal
  → signed P0 release checklist
```

Evidence is append-only and sanitized. Runtime services keep ports/adapters so
the hardening checks do not couple the domain layer to one hosting provider.
Every failure is a stable public error or a scrubbed operational event; raw
causes remain server-side diagnostics outside user-visible responses.

## Planned sequence

1. **6.1 CI and artifact provenance:** migrate-first ordering, frozen install,
   SBOM/digest capture, and release checklist skeleton.
2. **6.2 Deployment rehearsal:** full-stack preflight, expand/contract migration,
   rollback, queue recovery, and secret/config validation.
3. **6.3 Observability:** probes, metrics, alert delivery/recovery, log redaction,
   and operator runbook verification.
4. **6.4 Backup and restore:** encrypted backup, retention cutoff, isolated restore,
   relationship/hash assertions, and pre-destructive hook.
5. **6.5 Performance and browser matrix:** exact workload, latest-two browsers,
   axe/keyboard, VoiceOver/NVDA, and immutable reports.
6. **6.6 Release gate:** rerun all P0 checks from a clean candidate and publish
   the evidence index; stop on any unresolved P0 blocker.

## Acceptance

Phase6 is complete when the P0 checklist has no blocked rows, every required
artifact is reproducible from a clean checkout, rollback and restore drills
have passed in isolated targets, and the release transcript contains no secret
or document-content leakage. A P1 item may be scheduled later only through a
new approved design and implementation plan.
