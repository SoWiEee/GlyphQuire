# Phase 6 Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every P0 production-readiness gate with reproducible evidence, reversible deployment, and sanitized operational artifacts.

**Architecture:** Keep application/domain code behind existing database, object-storage, queue, and alert ports. Build a release-candidate pipeline that produces immutable artifacts, validates migrations and preflight before traffic, runs full-stack evidence against isolated targets, and records one append-only P0 checklist.

**Tech Stack:** GitHub Actions, pnpm 9, Node 22, Vite 8, oxlint, oxfmt, PostgreSQL 17, MinIO/S3 API, Graphile-style jobs, Playwright, axe, shell runbooks.

## Global Constraints

- P0 is release-blocking; P1-01 through P1-12 remain non-blocking and out of scope.
- The workload ceiling is five concurrent users; no HA, multi-region, formal availability SLO, or scale promise is added.
- Migrations are forward-only and must preserve frozen historical bytes; runtime roles cannot DDL, alter migration journals, or use migration credentials.
- Evidence must exclude secrets, cookies, tokens, presigned URLs, Markdown bodies, archive contents, and provider diagnostics.
- Missing required configuration or external evidence fails closed; smoke-only runs cannot satisfy P0.

---

### Task 1: Define the release checklist and artifact manifest

**Files:**
- Create: `docs/evidence/phase6/p0-release-checklist.md`
- Create: `docs/evidence/phase6/artifact-manifest.schema.json`
- Create: `packages/shared/src/phase6-checklist.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `.github/workflows/ci.yml`
- Test: `tests/integration/phase6-release-checklist.test.ts`

**Interfaces:**
- Consume P0 rows from `docs/SPEC.md` §49 and existing Phase5 evidence paths.
- Produce exported `phase6ChecklistSchema` rows whose status may be `blocked`, `in_progress`, or `passed`, plus `phase6ReleaseDecisionSchema` that accepts only fourteen `passed` rows and matching immutable build metadata from `packages/shared/src/phase6-checklist.ts`.

- [ ] **Step 1: Write RED checklist tests.**

```ts
import { expect, it } from "vitest";
import { phase6ChecklistSchema, phase6ReleaseDecisionSchema } from "@glyphquire/shared";

it("records blocked evidence but rejects it as a release decision", () => {
  expect(phase6ChecklistSchema.parse({ gate: "P0-08", status: "blocked" })).toMatchObject({
    status: "blocked",
  });
  expect(() => phase6ReleaseDecisionSchema.parse({ rows: [{ gate: "P0-08", status: "blocked" }] })).toThrow();
});
```

- [ ] **Step 2: Run the RED test.**

Run: `pnpm exec vitest run --config /dev/null tests/integration/phase6-release-checklist.test.ts`

Expected: FAIL because the schema and checklist are absent.

- [ ] **Step 3: Implement schema, checklist, and CI artifact capture.**

The checklist must enumerate P0-01 through P0-14 exactly once. CI must retain the commit SHA, lockfile hash, Node/pnpm versions, migration journal hash, and build/image digest without recording secrets. Export both schemas from `packages/shared/src/index.ts`. Keep the existing migration-before-tests ordering.

- [ ] **Step 4: Run GREEN checks.**

Run: `pnpm exec vitest run --config /dev/null tests/integration/phase6-release-checklist.test.ts && pnpm typecheck && pnpm lint && pnpm format:check`

Expected: all checks pass.

- [ ] **Step 5: Commit.**

```bash
git add docs/evidence/phase6 packages/shared/src/phase6-checklist.ts packages/shared/src/index.ts .github/workflows/ci.yml tests/integration/phase6-release-checklist.test.ts
git commit -m "ops: define phase6 release checklist"
```

### Task 2: Rehearse deployment, migration, rollback, and queue recovery

**Files:**
- Create: `infra/phase6/phase6-deploy.sh`
- Create: `infra/phase6/phase6-rollback.sh`
- Create: `infra/phase6/phase6-queue-recovery.sh`
- Create: `infra/phase6/phase6-hosted-preflight.sh`
- Create: `tests/integration/phase6-deployment.test.ts`
- Modify: `docs/deployment/phase5-release-runbook.md` with Phase6 links

- [ ] **Step 1: Write RED isolated-target tests.** Assert deploy refuses missing migration/runtime role separation, rollback refuses a non-isolated target, and queue recovery refuses an unbounded replay.
- [ ] **Step 2: Run RED.** `pnpm exec vitest run --config /dev/null tests/integration/phase6-deployment.test.ts` must fail before scripts exist.
- [ ] **Step 3: Implement bounded scripts.** Each script accepts explicit target URLs from environment, validates canonical host/database names, runs preflight before service start, writes only scrubbed JSON events, and exits non-zero on any failed precondition. `phase6-hosted-preflight.sh` checks the hosted `/api/health` and `/api/ready` endpoints, PostgreSQL migration/runtime role separation, S3 bucket access, worker readiness, and image digest before traffic. Rollback uses the prior immutable digest and never rewrites migration history.
- [ ] **Step 4: Run GREEN in disposable Compose and hosted rehearsal targets.** `PHASE6_TARGET=isolated pnpm exec vitest run --config /dev/null tests/integration/phase6-deployment.test.ts` must pass and leave no live target behind; `PHASE6_HOSTED_BASE_URL=https://staging.example PHASE6_HOSTED_IMAGE_DIGEST=sha256:0000000000000000000000000000000000000000000000000000000000000000 infra/phase6/phase6-hosted-preflight.sh` must pass only after all hosted checks respond successfully.
- [ ] **Step 5: Commit.** `git add infra/phase6 tests/integration/phase6-deployment.test.ts docs/deployment/phase5-release-runbook.md && git commit -m "ops: rehearse phase6 deployment recovery"`

### Task 3: Complete observability and alert delivery evidence

**Files:**
- Create: `infra/observability/phase6-alert-rules.yml`
- Create: `tests/integration/phase6-observability.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/middleware/error-handler.ts`
- Modify: `apps/api/src/routes/health.ts`
- Modify: `apps/worker/src/scheduler.ts`
- Modify: `docs/evidence/phase5/alert-delivery.md` and `docs/evidence/phase5/README.md`

- [ ] **Step 1: Write RED alert tests.** Cover probe cadence, three-failure threshold, queue age/dead-letter/backup conditions, five-minute notification deadline, recovery notification, and secret-free payloads.
- [ ] **Step 2: Run RED.** `pnpm exec vitest run --config /dev/null tests/integration/phase6-observability.test.ts` must fail before rules/evidence exist.
- [ ] **Step 3: Implement rules and adapter wiring.** Modify `apps/api/src/app.ts` logger construction, `apps/api/src/middleware/error-handler.ts` redaction, `apps/api/src/routes/health.ts` readiness metrics, and `apps/worker/src/scheduler.ts` alert emission. Use stable event names, request/job correlation IDs, bounded counters, and redaction before transport. Never include document bodies, credentials, provider responses, or URLs.
- [ ] **Step 4: Run GREEN with a configured operator-channel capture.** `PHASE6_ALERT_EVIDENCE_FILE=/secure/path/sanitized-alert.json pnpm test:alerting:phase5 && pnpm exec vitest run --config /dev/null tests/integration/phase6-observability.test.ts` must pass and the evidence file must validate against the strict schema.
- [ ] **Step 5: Commit.** `git add infra/observability docs/evidence/phase5 tests/integration/phase6-observability.test.ts apps/api/src/app.ts apps/api/src/middleware/error-handler.ts apps/api/src/routes/health.ts apps/worker/src/scheduler.ts && git commit -m "ops: finalize phase6 observability evidence"`

### Task 4: Execute encrypted backup and isolated restore drill

**Files:**
- Modify: `infra/backup/phase5-backup.sh`
- Modify: `infra/backup/phase5-restore-drill.sh`
- Create: `tests/integration/phase6-backup-restore.test.ts`
- Modify: `docs/evidence/phase5/backup-restore-drill.md`

- [ ] **Step 1: Write RED tests.** Reject wrong encryption algorithm/key handling, non-isolated restore targets, missing relationship/hash checks, retention beyond 30 days, and evidence containing raw object names.
- [ ] **Step 2: Run RED.** `pnpm exec vitest run --config /dev/null tests/integration/phase6-backup-restore.test.ts` must fail before the hardening checks exist.
- [ ] **Step 3: Implement and harden scripts.** Preserve AES-256 encryption, 30-day cutoff, pre-destructive hook, separate database/bucket targets, append-only aggregate evidence, and cleanup of temporary key material on success/failure.
- [ ] **Step 4: Run GREEN against disposable PostgreSQL and object-storage targets.** `PHASE6_BACKUP_EVIDENCE=1 pnpm exec vitest run --config /dev/null tests/integration/phase6-backup-restore.test.ts` must pass with relationship and aggregate-hash assertions.
- [ ] **Step 5: Commit.** `git add infra/backup tests/integration/phase6-backup-restore.test.ts docs/evidence/phase5/backup-restore-drill.md && git commit -m "ops: verify encrypted backup restore"`

### Task 5: Run exact performance and browser/accessibility gates

**Files:**
- Modify: `tests/load/phase5-product-services.ts` only for missing manifest/evidence fields
- Create: `tests/load/phase6-environment.ts`
- Create: `tests/performance/phase6-release.perf.spec.ts`
- Create: `tests/e2e/phase6-browser-matrix.spec.ts`
- Create: `tests/e2e/phase6-browserstack.ts`
- Create: `configs/phase6-browser-matrix.json`
- Modify: `playwright.config.ts` to expose current local Chromium/Edge/Firefox/WebKit projects
- Modify: `docs/evidence/phase5/performance-load.md` and `docs/evidence/phase5/browser-accessibility.md`

- [ ] **Step 1: Write RED evidence validators.** Reject smoke-only duration, fewer than five actors, fewer than 500 samples per route, p95 over the SPEC limits, browser version gaps, axe violations, missing keyboard flow, or missing VoiceOver/NVDA result.
- [ ] **Step 2: Run RED with absent evidence.** `pnpm test:load:phase5 -- --duration=1s --users=1` must exit with `PHASE5_LOAD_SKIPPED_RELEASE_BLOCKER`; browser matrix must report every missing target.
- [ ] **Step 3: Implement exact workload/matrix harnesses.** `tests/load/phase6-environment.ts` must measure Linux x86-64 host limits from `os.arch()`, `os.cpus()`, `/sys/fs/cgroup/cpu.max`, and `/sys/fs/cgroup/memory.max`; it fails closed when any value is unreadable or the measured quota is below 4 vCPU or 8 GiB. Self-declared CPU/memory environment variables are not accepted. Keep retries disabled for performance, record measured host resources, commit/image digest, queue drain and integrity counters, and redact all identifiers/content. `playwright.config.ts` must define explicit local `chromium`, `msedge`, `firefox`, and `webkit` projects; WebKit is diagnostic only and is never counted as Safari evidence. `configs/phase6-browser-matrix.json` must enumerate exactly eight BrowserStack targets: Chrome `latest`/`latest-1`, Firefox `latest`/`latest-1`, Edge `latest`/`latest-1`, and Safari `latest`/`latest-1`, each with the provider's OS/version fields.
- [ ] **Step 4: Run GREEN on the release environment and BrowserStack.** `pnpm exec tsx tests/load/phase6-environment.ts && pnpm test:load:phase5 -- --duration=30m --users=5` must pass only on the measured 4-vCPU/8-GiB Linux x86-64 host. `BROWSERSTACK_USERNAME="$BROWSERSTACK_USERNAME" BROWSERSTACK_ACCESS_KEY="$BROWSERSTACK_ACCESS_KEY" PHASE6_BROWSERSTACK_BUILD="phase6-${GITHUB_SHA}" PHASE6_BASE_URL="https://staging.example" pnpm exec tsx tests/e2e/phase6-browserstack.ts --matrix configs/phase6-browser-matrix.json --spec tests/e2e/phase6-browser-matrix.spec.ts` connects with Playwright `chromium.connect` to BrowserStack's CDP endpoint, runs all eight actual Chrome/Firefox/Edge/Safari targets, records provider-reported browser versions and OS, and writes a schema-validated `docs/evidence/phase6/browser-matrix.json` without credentials. The repository Playwright projects (`chromium`, `msedge`, `firefox`, `webkit`) remain local smoke checks only; WebKit never substitutes for Safari. The release owner additionally runs the exact same BrowserStack matrix with VoiceOver on macOS and NVDA on Windows using the provider's screen-reader-capable sessions; a missing screen-reader artifact keeps P0-14 blocked.
- [ ] **Step 5: Commit.** `git add tests/load tests/performance tests/e2e configs/phase6-browser-matrix.json playwright.config.ts docs/evidence/phase5 docs/evidence/phase6 && git commit -m "test: capture phase6 release performance evidence"`

### Task 6: Rehearse and publish the P0 release decision

**Files:**
- Create: `infra/phase6/phase6-release-gate.sh`
- Modify: `docs/evidence/phase6/p0-release-checklist.md`
- Create: `tests/integration/phase6-release-gate.test.ts`

- [ ] **Step 1: Write RED final-gate tests.** Require all fourteen P0 rows green, immutable artifacts present, rollback and restore statuses passed, and zero secret/content matches.
- [ ] **Step 2: Run RED from a clean checkout.** `pnpm exec vitest run --config /dev/null tests/integration/phase6-release-gate.test.ts` must fail while any evidence row is blocked.
- [ ] **Step 3: Implement fail-closed aggregation.** The gate reads only schema-validated evidence, compares commit/image/migration identities, refuses stale artifacts, and emits one scrubbed release decision. It never changes application data or migration journals.
- [ ] **Step 4: Run GREEN and archive the transcript.** `PHASE6_RELEASE_CANDIDATE=1 infra/phase6/phase6-release-gate.sh` must pass only after Tasks 1–5 artifacts are present; publish the checklist and immutable links.
- [ ] **Step 5: Commit and tag the candidate.** `git add infra/phase6 docs/evidence/phase6 tests/integration/phase6-release-gate.test.ts && git commit -m "release: close phase6 p0 gates" && git tag phase6-rc`

## Final Verification

Run: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm -r test && pnpm test:cross-package && pnpm test:integration && pnpm test:e2e`

Expected: every command exits 0; the P0 checklist has no blocked rows; all
artifacts reference the same commit/image/migration identities; no evidence
contains a secret or document body; and P1 remains explicitly deferred.
