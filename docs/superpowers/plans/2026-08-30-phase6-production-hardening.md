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
- Phase6 is schema-neutral: it adds no database migration. It must rehearse the
  existing frozen 0000–0011 chain and prove that both the candidate and the
  immediately previous application artifact run against that schema without
  rewriting journal or snapshot bytes.

---

### Task 1: Define the release checklist and artifact manifest

**Files:**

- Create: `docs/evidence/phase6/p0-release-checklist.md`
- Create: `docs/evidence/phase6/artifact-manifest.schema.json`
- Create: `docs/evidence/phase6/release-decision.schema.json`
- Create: `infra/phase6/images/api.Dockerfile`
- Create: `infra/phase6/images/web.Dockerfile`
- Create: `infra/phase6/images/worker.Dockerfile`
- Create: `packages/shared/src/phase6-checklist.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `package.json` to expose `test:integration:phase6`, `test:integration:phase6-observability`, and `test:release:phase6`
- Modify: `.github/workflows/ci.yml`
- Test: `tests/integration/phase6-release-checklist.test.ts`

**Interfaces:**

- Consume P0 rows from `docs/SPEC.md` §49 and existing Phase5 evidence paths.
- Produce exported `phase6ChecklistSchema` rows whose status may be `blocked`, `in_progress`, or `passed`, plus `phase6ReleaseDecisionSchema` that accepts only fourteen `passed` rows and matching immutable build metadata from `packages/shared/src/phase6-checklist.ts`. The JSON schemas and TypeScript schemas must describe the same fields and enum values.

- [ ] **Step 1: Write RED checklist tests.**

```ts
import { expect, it } from "vitest";
import { phase6ChecklistSchema, phase6ReleaseDecisionSchema } from "@glyphquire/shared";

it("records blocked evidence but rejects it as a release decision", () => {
  expect(phase6ChecklistSchema.parse({ gate: "P0-08", status: "blocked" })).toMatchObject({
    status: "blocked",
  });
  expect(() =>
    phase6ReleaseDecisionSchema.parse({ rows: [{ gate: "P0-08", status: "blocked" }] }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the RED test.**

Run: `pnpm exec vitest run --config /dev/null tests/integration/phase6-release-checklist.test.ts`

Expected: FAIL because the schema and checklist are absent.

- [ ] **Step 3: Implement schema, checklist, and CI artifact capture.**

The checklist must enumerate P0-01 through P0-14 exactly once. CI must build the three owned OCI images from the phase6 Dockerfiles, retain the candidate source SHA, lockfile hash, Node/pnpm versions, frozen 0000–0011 migration journal/hash map, and immutable API/web/worker image digests without recording secrets. Add the root scripts `test:integration:phase6` (only deterministic checklist/deployment/preflight/backup tests), `test:integration:phase6-observability` (the Compose evaluator/router/receiver orchestration), and `test:release:phase6` (the external-evidence release gate); the ordinary script must not glob in intentionally blocked release-gate or manual screen-reader tests. Update `.github/workflows/ci.yml` with an explicit `pnpm test:integration:phase6` step after the existing package integration step; a separate release-candidate job invokes the observability/performance/browser/manual evidence scripts only after external secrets and targets are provisioned. Export both schemas from `packages/shared/src/index.ts`. Keep the existing migration-before-tests ordering; the immutable artifact manifest is generated only at the post-Task-5 candidate freeze so it cannot describe an earlier source tree.
Use explicit script file lists: `test:integration:phase6` runs `tests/integration/phase6-release-checklist.test.ts`, `phase6-deployment.test.ts`, `phase6-preflight-route.test.ts`, and `phase6-backup-restore.test.ts`; `test:integration:phase6-observability` runs `infra/observability/phase6-observability-test.sh`; `test:release:phase6` runs `infra/phase6/phase6-release-gate.sh`.

- [ ] **Step 4: Run GREEN checks.**

Run: `pnpm exec vitest run --config /dev/null tests/integration/phase6-release-checklist.test.ts && pnpm typecheck && pnpm lint && pnpm format:check`

Expected: all checks pass.

- [ ] **Step 5: Commit.**

```bash
git add docs/evidence/phase6/p0-release-checklist.md docs/evidence/phase6/artifact-manifest.schema.json docs/evidence/phase6/release-decision.schema.json infra/phase6/images/api.Dockerfile infra/phase6/images/web.Dockerfile infra/phase6/images/worker.Dockerfile packages/shared/src/phase6-checklist.ts packages/shared/src/index.ts package.json .github/workflows/ci.yml tests/integration/phase6-release-checklist.test.ts
git commit -m "ops: define phase6 release checklist"
```

### Task 2: Rehearse deployment, migration, rollback, and queue recovery

**Files:**

- Create: `infra/phase6/phase6-deploy.sh`
- Create: `infra/phase6/phase6-rollback.sh`
- Create: `infra/phase6/phase6-queue-recovery.sh`
- Create: `infra/phase6/phase6-hosted-preflight.sh`
- Create: `apps/api/src/routes/internal-phase6-preflight.ts`
- Create: `tests/integration/phase6-preflight-route.test.ts`
- Create: `docs/evidence/phase6/deployment-evidence.schema.json`
- Create: `docs/evidence/phase6/deployment-rehearsal.json` (generated sanitized instance)
- Create: `tests/integration/phase6-deployment.test.ts`
- Modify: `docs/deployment/phase5-release-runbook.md` with Phase6 links

- [ ] **Step 1: Write RED isolated-target tests.** Assert deploy refuses missing migration/runtime role separation, rollback refuses a non-isolated target, and queue recovery refuses an unbounded replay. Add a compatibility rehearsal that applies the exact frozen 0000–0011 artifacts to an empty target, records every journal/snapshot hash, boots candidate and previous images against that target, performs a bounded read/write probe, and asserts the hashes remain byte-identical after both boots and an application rollback.
- [ ] **Step 2: Run RED.** `pnpm exec vitest run --config /dev/null tests/integration/phase6-deployment.test.ts` must fail before scripts exist.
- [ ] **Step 3: Implement bounded scripts.** Each script accepts explicit target URLs from environment, validates canonical host/database names, runs preflight before service start, writes only scrubbed JSON events, and exits non-zero on any failed precondition. The deployment test must migrate an isolated database through the existing 0000–0011 artifacts, compare every frozen historical hash/journal entry, boot the candidate image by its recorded digest, then boot the immediately previous application image by its recorded digest against the same schema and run read/write compatibility probes; tags, mutable registry manifests, or an unverified previous-release URL are rejected. Rollback is an application-image rollback only; it never rewrites migration history. `internal-phase6-preflight.ts` is an authenticated operator-only route with an authorization test; its response contains only scrubbed booleans and expected identities. The route is mounted by the sequential app integration owner in Task 3. `phase6-hosted-preflight.sh` reads secrets only from `PHASE6_HOSTED_ENV_FILE` (a vault-provided file with `PHASE6_HOSTED_DATABASE_URL`, `PHASE6_HOSTED_MIGRATION_DATABASE_URL`, `PHASE6_HOSTED_S3_*`, and `PHASE6_HOSTED_PROBE_TOKEN`; never prints them), queries expected `PHASE6_EXPECTED_RUNTIME_ROLE`, `PHASE6_EXPECTED_MIGRATION_ROLE`, `PHASE6_EXPECTED_WORKER_ID`, `PHASE6_EXPECTED_BUCKET`, `PHASE6_EXPECTED_IMAGE_DIGEST`, and `PHASE6_EXPECTED_MIGRATION_JOURNAL_SHA`, and calls the authenticated internal preflight endpoint. A base URL and image digest alone are insufficient.
- [ ] **Step 4: Run GREEN in disposable Compose and hosted rehearsal targets.** `PHASE6_TARGET=isolated pnpm exec vitest run --config /dev/null tests/integration/phase6-deployment.test.ts` must pass and leave no live target behind. Hosted preflight is executed only after the Task 3 app-mount commit by the authorized `phase6-hosted-preflight` CI job; in a release shell with the vault file mounted, `PHASE6_HOSTED_ENV_FILE=/run/secrets/glyphquire-phase6-hosted.env PHASE6_HOSTED_BASE_URL=https://staging.example PHASE6_HOSTED_PREFLIGHT_PATH=/api/internal/phase6/preflight PHASE6_EXPECTED_RUNTIME_ROLE=glyphquire_app PHASE6_EXPECTED_MIGRATION_ROLE=glyphquire_migration PHASE6_EXPECTED_WORKER_ID="$PHASE6_EXPECTED_WORKER_ID" PHASE6_EXPECTED_BUCKET="$PHASE6_EXPECTED_BUCKET" PHASE6_EXPECTED_IMAGE_DIGEST="$PHASE6_EXPECTED_IMAGE_DIGEST" PHASE6_EXPECTED_MIGRATION_JOURNAL_SHA="$PHASE6_EXPECTED_MIGRATION_JOURNAL_SHA" infra/phase6/phase6-hosted-preflight.sh` must pass only after health, readiness, role, S3, worker, digest, and frozen-journal checks succeed. The vault file supplies the non-printed database/S3/probe secrets and the expected worker/bucket/image/journal values.
- [ ] **Step 5: Commit.** `git add infra/phase6/phase6-deploy.sh infra/phase6/phase6-rollback.sh infra/phase6/phase6-queue-recovery.sh infra/phase6/phase6-hosted-preflight.sh apps/api/src/routes/internal-phase6-preflight.ts tests/integration/phase6-preflight-route.test.ts docs/evidence/phase6/deployment-evidence.schema.json docs/evidence/phase6/deployment-rehearsal.json tests/integration/phase6-deployment.test.ts docs/deployment/phase5-release-runbook.md && git commit -m "ops: rehearse phase6 deployment recovery"`

### Task 3: Complete observability and alert delivery evidence

**Files:**

- Create: `infra/observability/phase6-alert-rules.yml`
- Create: `infra/observability/phase6-alert-router.yml`
- Create: `infra/observability/phase6-alert-runtime.ts`
- Create: `infra/observability/phase6-alert-receiver.ts`
- Create: `infra/observability/phase6-alert-runtime.Dockerfile`
- Create: `infra/observability/phase6-alert-evaluator.yml`
- Create: `infra/observability/phase6-observability-test.sh`
- Create: `infra/observability/docker-compose.phase6.yml`
- Create: `docs/evidence/phase6/alert-evidence.schema.json`
- Create: `docs/evidence/phase6/alert-evidence.json` (generated sanitized instance)
- Create: `tests/integration/phase6-observability.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/middleware/error-handler.ts`
- Modify: `apps/api/src/routes/health.ts`
- Modify: `apps/worker/src/scheduler.ts`
- Modify: `docs/evidence/phase5/alert-delivery.md` and `docs/evidence/phase5/README.md`

The app integration owner must mount `internal-phase6-preflight.ts` in `apps/api/src/app.ts`
in the same sequential change; Task 2 owns the route and authorization test, while
Task 3 owns the app mount and its readiness metrics.

- [ ] **Step 1: Write RED alert tests.** Cover the 30-second probe cadence with a five-second timeout, three consecutive failures, 50% failures in any five-minute rolling window, immediate backup/dead-letter/oldest-queue alerts, database/disk warnings at 80% and critical alerts at 90%, notification delivery within five minutes, readiness removal of new traffic, health-triggered restart action, three consecutive successes for recovery, and secret-free payloads.
- [ ] **Step 2: Run RED.** `pnpm exec vitest run --config /dev/null tests/integration/phase6-observability.test.ts` must fail before rules/evidence exist.
- [ ] **Step 3: Implement rules and adapter wiring.** Modify `apps/api/src/app.ts` logger construction and mount, `apps/api/src/middleware/error-handler.ts` redaction, `apps/api/src/routes/health.ts` readiness metrics, and `apps/worker/src/scheduler.ts` alert emission. Encode the exact 30-second/5-second probe, three-consecutive and 50%-within-five-minutes failure rules, immediate backup/dead-letter/oldest-queue alerts, 80% warning/90% critical database and disk rules, five-minute delivery deadline, three-success recovery, readiness traffic removal, and health restart action. `phase6-alert-runtime.Dockerfile` builds the evaluator/runtime from a pinned Node base digest, `phase6-alert-evaluator.yml` is its explicit rule/evaluation config, and `docker-compose.phase6.yml` pins the resulting image by digest with `/ready` healthchecks. It starts the evaluator/router and `phase6-alert-receiver.ts`; `phase6-alert-router.yml` loads the rule file, routes to the configured operator channel, and defines that receiver. Use stable event names, request/job correlation IDs, bounded counters, and redaction before transport. Never include document bodies, credentials, provider responses, or URLs.
- [ ] **Step 4: Run GREEN with a configured operator-channel capture.** The test must drive three consecutive failures and a 50%-within-five-minutes rolling failure window through the real evaluator/router/receiver path, assert a firing event within five minutes, assert readiness removes new traffic and health failure invokes the restart action, then drive three consecutive successes and assert a resolved event. `PHASE6_ALERT_EVIDENCE_HOST_PATH=/secure/path/sanitized-alert.json pnpm test:integration:phase6-observability` starts the pinned Compose services, waits on evaluator/router/receiver readiness, mounts the capture path, runs the Phase6 validator with both `PHASE5_ALERT_EVIDENCE_FILE` and `PHASE6_ALERT_EVIDENCE_FILE`, reads back the mounted receiver file, and always tears the stack down. Both events validate against `docs/evidence/phase6/alert-evidence.schema.json` before the sanitized instance is added to Task 6’s inventory.
- [ ] **Step 5: Commit.** `git add infra/observability/phase6-alert-rules.yml infra/observability/phase6-alert-router.yml infra/observability/phase6-alert-runtime.ts infra/observability/phase6-alert-receiver.ts infra/observability/phase6-alert-runtime.Dockerfile infra/observability/phase6-alert-evaluator.yml infra/observability/docker-compose.phase6.yml infra/observability/phase6-observability-test.sh docs/evidence/phase6/alert-evidence.schema.json docs/evidence/phase6/alert-evidence.json docs/evidence/phase5/alert-delivery.md docs/evidence/phase5/README.md tests/integration/phase6-observability.test.ts apps/api/src/app.ts apps/api/src/middleware/error-handler.ts apps/api/src/routes/health.ts apps/worker/src/scheduler.ts && git commit -m "ops: finalize phase6 observability evidence"`

### Task 4: Execute encrypted backup and isolated restore drill

**Files:**

- Modify: `infra/backup/phase5-backup.sh`
- Modify: `infra/backup/phase5-restore-drill.sh`
- Create: `docs/evidence/phase6/backup-restore-evidence.schema.json`
- Create: `docs/evidence/phase6/backup-restore.json` (generated sanitized instance)
- Create: `tests/integration/phase6-backup-restore.test.ts`
- Modify: `docs/evidence/phase5/backup-restore-drill.md`

- [ ] **Step 1: Write RED tests.** Reject wrong encryption algorithm/key handling, non-isolated restore targets, missing relationship/hash checks, retention beyond 30 days, and evidence containing raw object names.
- [ ] **Step 2: Run RED.** `pnpm exec vitest run --config /dev/null tests/integration/phase6-backup-restore.test.ts` must fail before the hardening checks exist.
- [ ] **Step 3: Implement and harden scripts.** Preserve AES-256 encryption, 30-day cutoff, pre-destructive hook, separate database/bucket targets, append-only aggregate evidence, and cleanup of temporary key material on success/failure.
- [ ] **Step 4: Run GREEN against disposable PostgreSQL and object-storage targets.** `PHASE6_BACKUP_EVIDENCE=1 pnpm exec vitest run --config /dev/null tests/integration/phase6-backup-restore.test.ts` must pass with relationship and aggregate-hash assertions.
- [ ] **Step 5: Commit.** `git add infra/backup/phase5-backup.sh infra/backup/phase5-restore-drill.sh docs/evidence/phase6/backup-restore-evidence.schema.json docs/evidence/phase6/backup-restore.json tests/integration/phase6-backup-restore.test.ts docs/evidence/phase5/backup-restore-drill.md && git commit -m "ops: verify encrypted backup restore"`

### Evidence inventory and lifecycle

Task 6 owns the final inventory and must stage these exact generated instances,
not an evidence-directory wildcard: `docs/evidence/phase6/deployment-rehearsal.json`,
`backup-restore.json`, `alert-evidence.json`, `browser-matrix.json`,
`performance-environment.json`, `performance-load.json`, and
`artifact-manifest.json`, `release-decision.json`. Each instance validates
against its adjacent schema, includes the same commit/image/migration identities,
and records a timestamp, producer version, and pass/fail lifecycle. A failed
attempt is retained as a scrubbed `failed` record; a later rerun appends a new
`passed` record and never edits history. The release gate rejects missing
recovery events, stale producer versions, mismatched identities, or evidence
that is only a smoke/placeholder run. Manual `voiceover-macos.json` and
`nvda-windows.json` are also required inventory entries and remain blocked until
the release owner supplies real captures.

### Task 5: Run exact performance and browser/accessibility gates

**Files:**

- Modify: `tests/load/phase5-product-services.ts` only for missing manifest/evidence fields
- Create: `tests/load/phase6-environment.ts`
- Create: `tests/performance/phase6-release.perf.spec.ts`
- Create: `tests/e2e/phase6-browser-matrix.spec.ts`
- Create: `tests/e2e/phase6-browserstack.ts`
- Create: `configs/phase6-browser-matrix.json`
- Create: `configs/phase6-browserstack.yml` (credential-free SDK capability template)
- Create: `docs/evidence/phase6/browser-matrix.schema.json`
- Create: `docs/evidence/phase6/performance-evidence.schema.json`
- Create: `docs/evidence/phase6/browser-matrix.json` (generated sanitized instance)
- Create: `docs/evidence/phase6/performance-load.json` (generated sanitized instance)
- Create: `docs/evidence/phase6/performance-environment.json` (generated host manifest)
- Create: `docs/evidence/phase6/performance-environment.schema.json`
- Modify: `package.json` and `pnpm-lock.yaml` to add the pinned `browserstack-node-sdk` used by the provider harness
- Modify: `playwright.config.ts` to expose current local Chromium/Edge/Firefox/WebKit projects
- Modify: `docs/evidence/phase5/performance-load.md` and `docs/evidence/phase5/browser-accessibility.md`

- [ ] **Step 1: Write RED evidence validators.** Reject smoke-only duration, a workload that is not exactly five concurrent actors/workspaces, fewer than 500 samples per route after the two-minute warm-up, p95 over the SPEC limits, missing exact UI warm-ups/samples/boundaries, any main-thread task over 200 ms during continuous typing, parsing over 100 KB that is neither in a Web Worker nor interruptible, browser version gaps, axe violations, missing keyboard flow, or missing VoiceOver/NVDA result.
- [ ] **Step 2: Run RED with absent evidence.** `pnpm test:load:phase5 -- --duration=1s --users=1` must exit with `PHASE5_LOAD_SKIPPED_RELEASE_BLOCKER`; browser matrix must report every missing target.
- [ ] **Step 3: Implement exact workload/matrix harnesses.** `tests/load/phase6-environment.ts` must measure Linux x86-64 host limits from `os.arch()`, `os.cpus()`, `/sys/fs/cgroup/cpu.max`, and `/sys/fs/cgroup/memory.max`; it fails closed when any value is unreadable or the measured quota is below 4 vCPU or 8 GiB. The performance run must use the mandated same-host Docker Compose topology for API, Worker, PostgreSQL, and object storage on one test network, preload exactly five workspaces × 1,000 notes, and record the resulting data volume. The browser performance spec must execute the exact SPEC measurements: 100 warm-ups + 1,000 samples for 100 KB input (InputEvent dispatch → next animation frame containing rendered change, p95 <100 ms); 10 warm-ups + 100 samples for Visual/Source switch (trigger → target editor accepts input, p95 <1 s); 5 warm-ups + 100 samples each for 1 MB open, save, and export with their request/action-to-acceptance/blob boundaries (each p95 <5 s). It must observe continuous typing for main-thread tasks >200 ms and prove parsing/validation above 100 KB runs in a Web Worker or interruptible path. Self-declared CPU/memory environment variables are not accepted. The environment probe atomically writes a SHA-256 content-addressed `docs/evidence/phase6/performance-environment.json`; `tests/load/phase5-product-services.ts` must accept the explicit `--environment-manifest` path, remeasure the same process host, validate the schema/hash/commit/image binding, and fail if values differ. Keep retries disabled for performance, record measured host resources, queue drain and integrity counters, and redact all identifiers/content. `playwright.config.ts` must define explicit local `chromium`, `msedge`, `firefox`, and `webkit` projects; WebKit is diagnostic only and is never counted as Safari evidence. `configs/phase6-browser-matrix.json` must enumerate exactly eight provider targets with explicit capability objects: Chrome `latest`/`latest-1`, Firefox `latest`/`latest-1`, Edge `latest`/`latest-1`, and Safari `latest`/`latest-1`, each using provider-supported OS/version values; `configs/phase6-browserstack.yml` must contain the credential-free SDK capability template.
- [ ] **Step 4: Run GREEN on the release environment and BrowserStack.** `pnpm exec tsx tests/load/phase6-environment.ts && pnpm test:load:phase5 -- --duration=30m --users=5 --environment-manifest=docs/evidence/phase6/performance-environment.json` must pass only when the workload consumes the measured manifest and reaches the 4-vCPU/8-GiB minimum on Linux x86-64. With credentials injected by the CI secret store, run `BROWSERSTACK_USERNAME="$BROWSERSTACK_USERNAME" BROWSERSTACK_ACCESS_KEY="$BROWSERSTACK_ACCESS_KEY" PHASE6_BROWSERSTACK_BUILD="phase6-${GITHUB_SHA}" PHASE6_BASE_URL="https://staging.example" pnpm exec tsx tests/e2e/phase6-browserstack.ts --sdk-config configs/phase6-browserstack.yml --matrix configs/phase6-browser-matrix.json --spec tests/e2e/phase6-browser-matrix.spec.ts --evidence docs/evidence/phase6/browser-matrix.json`; the harness uses the pinned `browserstack-node-sdk` and its supported Playwright integration (not a single raw Chromium CDP connection) to resolve each capability, runs all eight actual provider targets, reads back every provider session ID and numeric browser/OS version through the provider API, validates `docs/evidence/phase6/browser-matrix.schema.json`, and writes no credentials/diagnostics. It must preflight-resolve every target and fail closed instead of silently substituting Playwright WebKit for Safari. No automated provider matrix run counts as screen-reader evidence; Task 6 requires separate manual VoiceOver on macOS and manual NVDA on Windows captures, and missing either keeps P0-14 blocked.
- [ ] **Step 4a: Execute the release performance spec.** `pnpm exec playwright test tests/performance/phase6-release.perf.spec.ts --project=chromium` must consume the same `performance-environment.json`, use five actors and the measured host manifest, and fail closed when the manifest hash or route sample counts do not match the load run.
- [ ] **Step 5: Commit.** `git add tests/load/phase6-environment.ts tests/load/phase5-product-services.ts tests/performance/phase6-release.perf.spec.ts tests/e2e/phase6-browser-matrix.spec.ts tests/e2e/phase6-browserstack.ts configs/phase6-browser-matrix.json configs/phase6-browserstack.yml docs/evidence/phase6/browser-matrix.schema.json docs/evidence/phase6/performance-evidence.schema.json docs/evidence/phase6/performance-environment.schema.json docs/evidence/phase6/browser-matrix.json docs/evidence/phase6/performance-load.json docs/evidence/phase6/performance-environment.json playwright.config.ts package.json pnpm-lock.yaml docs/evidence/phase5/performance-load.md docs/evidence/phase5/browser-accessibility.md && git commit -m "test: capture phase6 release performance evidence"`

### Task 6: Rehearse and publish the P0 release decision

**Files:**

- Create: `infra/phase6/phase6-release-gate.sh`
- Modify: `docs/evidence/phase6/p0-release-checklist.md`
- Create: `docs/evidence/phase6/artifact-manifest.json` (generated only after candidate freeze)
- Create: `docs/evidence/phase6/release-decision.json` (generated sanitized instance)
- Create: `docs/evidence/phase6/screen-reader-evidence.schema.json`
- Test: `tests/integration/phase6-screen-reader-evidence.test.ts`
- Create: `tests/integration/phase6-release-gate.test.ts`
- Require external release-owner inputs: `docs/evidence/phase6/voiceover-macos.json` and `docs/evidence/phase6/nvda-windows.json` (real sanitized captures, never placeholders)

- [ ] **Step 0: Implement the release gate before freezing.** While source/config edits are still allowed, implement `phase6-release-gate.sh`, the checklist/schema/test harnesses, and the screen-reader validator. Run RED/GREEN against synthetic blocked evidence and verify that no gate emits a release decision until all fourteen rows and strict schemas are satisfied. This step produces no candidate evidence artifact and does not alter application data or migration journals.
- [ ] **Step 1: Freeze the release candidate.** After Tasks 1–5 and Step 0 code changes are committed, require a clean checkout and capture `candidateSourceSha`. Build and push API/web/worker images from exactly that SHA, resolve the immediately previous published release's immutable digests from `PHASE6_PREVIOUS_RELEASE_MANIFEST_URL` plus required `PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256` and signature verification and a recorded previous source SHA, and reject tags or mutable-only resolution. Generate `artifact-manifest.json` with both tuples plus frozen migration hashes. Regenerate every deployment, alert, backup, performance, browser, and manual evidence artifact against that immutable tuple. No source, lockfile, Dockerfile, or config edits are allowed after this boundary.
- [ ] **Step 2: Validate frozen evidence without emitting a decision.** `PHASE6_RELEASE_CANDIDATE=1 PHASE6_EMIT_DECISION=0 infra/phase6/phase6-release-gate.sh` must run from a clean checkout, fail while any evidence row is blocked, and otherwise validate every schema/identity, but must not write `release-decision.json` before the evidence-publication SHA exists.
- [ ] **Step 3: Confirm manual evidence and identities.** Run `pnpm exec vitest run --config /dev/null tests/integration/phase6-screen-reader-evidence.test.ts` against real `voiceover-macos.json` and `nvda-windows.json`; require path-specific `platform` (`macOS` + `VoiceOver` or `Windows` + `NVDA`), performer/reviewer, candidate/evidence identities, exact keyboard-flow step results, timestamp, non-placeholder recording reference plus checksum, and sanitized finding count. The BrowserStack matrix never substitutes for these manual captures.
- [ ] **Step 4: Prepare the release transcript.** The non-emitting gate and all Task 1–5 producers must have passed, every schema must validate, all required alert firing/recovery and browser session IDs must exist, and the measured host manifest must match the load evidence. No decision artifact is written yet.
- [ ] **Step 5: Obtain manual production approval, then publish evidence, decide, and tag.** Before any tag or deployment, the release owner must record an explicit approval (approver identity, timestamp, candidateSourceSha, artifact-manifest SHA, scope, and decision) in the release transcript; a missing or stale approval is release-blocking. First stage the exact non-decision evidence files (`artifact-manifest.json`, deployment/backup/alert/browser/performance instances, checklist, schemas, and manual screen-reader artifacts) and commit them as `release: publish phase6 evidence`; capture `evidencePublicationSha=$(git rev-parse HEAD)`. Then run the gate with `PHASE6_EVIDENCE_PUBLICATION_SHA="$evidencePublicationSha"` and the approval record to generate `release-decision.json`, stage only that decision, approval record, and its test transcript, commit `release: close phase6 p0 gates`, and tag `phase6-rc` only after the gate and approval are both passed. The decision records the prior evidence commit SHA rather than its own commit SHA, eliminating self-reference.

## Final Verification

Run ordinary CI: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm -r test && pnpm test:cross-package && pnpm test:integration && pnpm test:integration:phase6`.

Run release-candidate CI after the external environment is provisioned:
`pnpm test:integration:phase6-observability && pnpm exec playwright test tests/performance/phase6-release.perf.spec.ts --project=chromium && pnpm test:e2e && pnpm test:release:phase6`.

Expected: every command exits 0; the P0 checklist has no blocked rows; all
artifacts reference the same commit/image/migration identities; no evidence
contains a secret or document body; and P1 remains explicitly deferred.
