# Task 1 implementation report

## Outcome

The active product vocabulary now uses workspace/tools/operations/release names
through the shared contracts, API route, web client/store/workbench, worker
callers, tests, CI, Compose, release configuration, operational scripts, and
runbooks. The old Phase 5/6 public symbols, paths, environment keys, route, and
pending-storage key were removed without aliases or fallback reads.

Historical migration files and migration-fingerprint tests, existing
`docs/evidence/phase*/**`, `docs/security/phase*.md`, and the pre-existing
untracked `docs/superpowers/**` planning/spec files were not edited or staged.

## Changes

- Renamed active shared contracts to `workspaceServicesEnvSchema`,
  `WorkspaceServicesEnv`, `releaseChecklist`/`Release*`, neutral `Cursor` /
  `cursorSchema` / cursor codecs, and `JobRegistryDiagnostic` /
  `assertRequiredJobsComplete`.
- Replaced the public web maintenance API with the `WorkspaceToolsClient*`
  interfaces, `WorkspaceToolsStoreOptions`, `useWorkspaceToolsStore`, and the
  exact `glyphquire.workspace-tools.pending.v1` storage key. The old pending
  key is not read or migrated.
- Moved the internal readiness endpoint to
  `/api/internal/release/preflight`, mounted only under
  `/api/internal/release/*`, and renamed release environment/load/performance,
  alert, BrowserStack, integration, E2E, and operations interfaces.
- Consolidated the workbench save/status surface to one persistent
  `StatusBar`, changed visible tool labels to `Tools`/`Close tools`, removed
  the Readme demo maintenance and duplicate revision/save badges, and mapped
  maintenance, transfer, and asset diagnostics to human-readable copy.
- Renamed active release/operations infra, configs, backup services, runbooks,
  tests, Docker/Compose identifiers, CI references, and root scripts. The
  remaining Phase 0/2 migration references are immutable migration identifiers
  or fingerprint checks.
- Added `docs/evidence/release/**` schemas and scrubbed blocked evidence
  records. External gates now emit the stable `SKIPPED_EXTERNAL` marker and
  exit 2 when required target, host, credential, or pre-start tool inputs are
  unavailable; failures after a gate starts retain their release/backup/restore
  failure markers.

## Verification

All commands below were run from `/home/acane/Desktop/GlyphQuire`.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm -r test` | exit 0; all 15 workspace projects passed |
| `pnpm build` | exit 0 |
| `pnpm test:cross-package` | exit 0; 2 files, 58 tests passed |
| `pnpm test:integration` | exit 0; API 137 passed/154 skipped, queue 12 skipped |
| `pnpm test:integration:release` | exit 0; 6 files, 33 tests passed |
| `pnpm test:operations:alerting` | exit 0; 2 passed, 1 skipped |
| active-file `oxfmt --check` | exit 0; 101 changed active/evidence files formatted |
| `git diff HEAD --check` | exit 0 |
| required filtered Phase 5/6 grep | exit 1 with no matches (expected clean result) |
| protected hash recomputation + `cmp` | exit 0 (`protected_cmp=0`) |
| `bash -n` on release/backup/observability scripts | exit 0 |

`pnpm format:check` was also run as required. It exits 1 only for the three
pre-existing user-owned untracked planning files
`docs/superpowers/plans/2026-08-31-hallmark-cleanup.md`,
`docs/superpowers/plans/2026-08-31-ui-ux-direction.md`, and
`docs/superpowers/plans/2026-09-01-final-vocabulary-ui-cleanup.md`; those files
were intentionally left untouched. The active-file format check above passes.

External/configuration checks produced the required blocked semantics:

| Command | Result |
| --- | --- |
| `pnpm test:load:workspace -- --duration=1s --users=1` | exit 2, `SKIPPED_EXTERNAL` for missing workspace target/actors/operator inputs |
| `pnpm test:load:release-environment` | exit 2, `SKIPPED_EXTERNAL: cgroup CPU and memory limits are unreadable` |
| `pnpm test:browserstack:release` | exit 2, `SKIPPED_EXTERNAL: BrowserStack credentials are unavailable` |
| `pnpm test:performance:release -- --list` | exit 0 |
| `pnpm test:integration:release-observability` | exit 2, `SKIPPED_EXTERNAL: RELEASE_ALERT_EVIDENCE_HOST_PATH_MISSING` |
| `pnpm test:release` | exit 2, `RELEASE_BLOCKED` because release evidence/P0 rows are not passed |
| empty-config deploy/hosted-preflight/queue-recovery/rollback | exit 2 with `SKIPPED_EXTERNAL` markers |
| empty-config backup | exit 2, `SKIPPED_EXTERNAL: BACKUP_ENCRYPTION_KEY_MISSING` |
| isolated restore without database target | exit 2, `SKIPPED_EXTERNAL: RESTORE_DATABASE_URL_MISSING` |

## Notable decisions and deferred items

- Only pre-start external availability failures are classified as
  `SKIPPED_EXTERNAL`; malformed safety configuration and failures after a
  target/gate starts remain failure blockers.
- The release gate remains intentionally blocked until an external release
  owner supplies immutable artifact/publication identity, measured release
  environment, BrowserStack and screen-reader evidence, alert delivery
  evidence, and all passed P0 rows. No placeholder release decision was
  generated.
- The carried release UI evidence still records unavailable external
  assistive/cross-browser sessions and a local axe contrast finding; this task
  did not fabricate external evidence or alter the historical/user-owned
  records.

Implementation commit: pending
