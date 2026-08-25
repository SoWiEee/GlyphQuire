# Phase 2 Editors — Release Evidence

This is the Task 13 evidence index: Chrome E2E, accessibility, security-rendering,
performance, load, and build-provenance evidence for the Phase 2 editors, and — just as
important — an explicit list of what Phase 2 does **not** yet claim. It follows the same
`applicable` / `implemented` / `documented exception` vocabulary as
[`docs/security/phase2-compliance-matrix.md`](../../security/phase2-compliance-matrix.md),
which this document supplements rather than replaces.

## What this task discovered before writing evidence

`WorkbenchPage.vue` mounts `Workbench.vue` without a `sessionFactory` prop today
(`apps/web/src/pages/WorkbenchPage.vue`), so `Workbench.vue`'s `activateSession()` never
opens a real `EditorSession`. Concretely, on the live `/workspace` route right now:

- `SourceEditor` stays read-only (`sourceReadOnly` is `true` with no session; the adapter's
  own default is also `read-only` — `apps/web/src/components/source/SourceEditor.vue`).
- `onModeChange` in `Workbench.vue` is `if (!session) return;`, so the Visual/Split mode
  buttons cannot switch the active pane yet.
- Nothing that depends on a live `NoteClient` round trip (open, save, conflict, restore,
  takeover, checkpoint/version) is reachable through the UI.

This is expected at this point in Phase 2 — the API and its integration suite are real and
extensively tested (`apps/api/src/**/*.integration.test.ts`), but the web app has not been
wired to it yet. Every evidence artifact below is honest about this: what runs today runs
for real against a real Chrome, and what cannot run yet is a `.skip()`ed test with the exact
assertions to add and a pointer to the equivalent coverage that already exists at a lower
level (component/API integration).

## Chrome E2E — `tests/e2e/`

| File                                             | Covers                                                                                                                                                                                                                               | Status                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editor.spec.ts`                                 | Workbench shell rendering, tab open/switch/close, command palette (mouse, keyboard shortcut, filtering, backdrop close)                                                                                                              | Implemented and passing                                                                                                                                     |
| `editor.spec.ts`                                 | Typing updates the document; mode toggle switches the active pane                                                                                                                                                                    | `.skip()` — blocked on `WorkbenchPage.vue` wiring a `sessionFactory`                                                                                        |
| `accessibility.spec.ts`                          | axe (WCAG 2.1 A/AA) on the home page, workbench shell, and open command palette; keyboard-only navigation; visible focus; reduced motion; screen-reader-relevant landmark/role structure                                             | Implemented and passing (one known finding allowed through, see below)                                                                                      |
| `security-rendering.spec.ts`                     | Hostile payloads (`<script>`, `onerror`, `onload`, `<iframe>`, `javascript:` URLs) typed into the command palette cannot execute, navigate, dialog, or fire a network request; no hostile element exists anywhere in the mounted app | Implemented and passing                                                                                                                                     |
| `security-rendering.spec.ts`, `conflict.spec.ts` | Hostile Visual-mode Markdown, draft recovery, two-tab takeover, 409 conflict resolution (compare/copy/manual-merge/resubmit), soft-delete restore, checkpoint/version restore, uniform tenant 404                                    | `.skip()` — all blocked on the same session-wiring gap; each references the existing component-level or API-integration test it should match once reachable |

Run: `pnpm exec playwright test tests/e2e` (also `pnpm test:e2e`, and wired into CI —
see below).

### Accessibility: one known, deliberately-not-silently-passed finding

`EditorTabs.vue` nests a focusable "close tab" `<button>` inside its `role="tab"` element.
axe's `nested-interactive` rule (WCAG 4.1.2) flags this. Fixing it correctly needs a real
structural change (the close control has to become a keyboard-reachable sibling outside the
tab's own accessible-name computation — the ARIA APG "tabs with delete buttons" pattern),
not a class/attribute tweak, so it is out of scope for this evidence task. It is recorded as
an explicit, narrow allowance in `accessibility.spec.ts` (`KNOWN_AXE_FINDINGS`) with a
trip-wire test that fails the moment the finding disappears (so the allowance cannot go
stale silently) — it does not silently pass, and it does not block the rest of the
accessibility gate.

Three other real WCAG gaps that axe surfaced while writing this suite **were** fixed
directly, because they were small, safe, and unambiguous:

- `apps/web/src/editors/source/CodeMirrorSourceAdapter.ts` — the CodeMirror content region
  had no accessible name (`aria-input-field-name`); added `EditorView.contentAttributes.of({
"aria-label": "Note source markdown" })`.
- `apps/web/src/components/workbench/CommandPalette.vue`,
  `apps/web/src/components/workbench/TopBar.vue` — several `text-gray-400`/`text-gray-500`
  labels (command hints, the "No matching commands" message, the `⌘K` kbd hint) sat below
  the 4.5:1 contrast floor at their font sizes (`color-contrast`, some as low as 2.36:1);
  bumped to `text-gray-600`.
- `apps/web/src/components/workbench/CommandPalette.vue` — the filter input used Tailwind's
  `outline-none` with no replacement focus ring, so focus was invisible; removed the
  utility so the native focus outline (used everywhere else in the app) applies.

All 230 existing `apps/web` unit tests still pass after these changes
(`pnpm --filter @glyphquire/web test`).

## Performance — `tests/performance/editor.perf.spec.ts`

SPEC §40.1's reference environment (5-service Docker Compose host, five workspaces × 1,000
notes each) does not exist in this repository's Playwright config yet — `playwright.config.ts`'s
`webServer` runs only `@glyphquire/web dev`, no API, worker, or PostgreSQL. None of the four
SPEC §40.2 UI gates, the continuous-typing long-task gate, or the §40.4 API-sampling gates
can be measured for real until that stack exists and `WorkbenchPage.vue` is wired to it.

What this task delivers instead: every gate is written as a `.skip()` test implementing the
_exact_ SPEC boundary — the same warm-up/sample counts and the same start/end measurement
events — so a future change only has to delete `.skip(`, not rediscover the boundary. The
percentile-computation harness those tests share (`percentile`/`summarize`, nearest-rank
p50/p95/p99) is exercised by two always-on unit tests in the same file, so the one piece of
this suite's own logic that doesn't depend on the reference stack is proven correct today.

| Gate                             |      Warm-ups | Samples | Boundary                                                              |    Threshold | Status                                                     |
| -------------------------------- | ------------: | ------: | --------------------------------------------------------------------- | -----------: | ---------------------------------------------------------- |
| PERF-UI-01: 100 KB input         |           100 |   1,000 | `InputEvent` dispatch → next animation frame with the rendered change | p95 < 100 ms | `.skip()` — needs writable `SourceEditor`                  |
| PERF-UI-02: Visual/Source switch |            10 |     100 | trigger → target editor accepts input                                 |    p95 < 1 s | `.skip()` — needs a session (mode switch is a no-op today) |
| PERF-UI-03: 1 MB open            |             5 |     100 | request dispatch → editor accepts input                               |    p95 < 5 s | `.skip()` — needs a real `NoteClient.getNote` round trip   |
| PERF-UI-04: 1 MB save            |             5 |     100 | request dispatch → server ack + saved UI state                        |    p95 < 5 s | `.skip()` — needs a real `NoteClient.saveNote` round trip  |
| Continuous typing                |             — |       — | no main-thread long task > 200 ms                                     |    pass/fail | `.skip()` — needs writable `SourceEditor`                  |
| `GET note` (§40.4)               | 2 min warm-up |   ≥ 500 | —                                                                     | p95 < 500 ms | `.skip()` — needs a running API + PostgreSQL               |
| `PUT autosave` (§40.4)           | 2 min warm-up |   ≥ 500 | —                                                                     |    p95 < 1 s | `.skip()` — needs a running API + PostgreSQL               |

`GET search` and export stay outside Phase 2 per the brief and are not stubbed here.

## Load test — `tests/load/autosave-conflict.ts`

A complete, runnable five-user, ten-minute autosave/CAS-conflict load profile
(`pnpm test:load:phase2`): each user continuously autosaves a separate ~100 KB note every
two seconds, and every thirty seconds a controlled concurrent pair races a write against the
same base revision to exercise compare-and-swap. It independently verifies every
acknowledged revision and content hash through a fresh `GET`, checks operation-id
idempotency, and checks cross-tenant isolation (an outsider must get a uniform 404, never
a leak).

**This is not the deferred P0-08 thirty-minute workload** — SPEC §40.3's thirty-minute
profile additionally exercises search (every 10s) and a 5 MB asset upload (every 5 minutes)
per user, over three times the duration. This script must never be cited as satisfying
P0-08.

The script preflights its own dependencies (a reachable `/api/health`, and
`LOAD_TEST_WORKSPACE_IDS` — the API does not yet expose a way for a freshly-registered user
to discover their own workspace id, see the script's header comment) and, when they are
absent, prints exactly what is missing and exits `0` rather than failing the gate on
infrastructure this repository does not stand up yet. Run it in this repo today:

```
pnpm test:load:phase2
```

```
========================================================================
Phase 2 autosave/conflict load test — SKIPPED (infrastructure not available)
========================================================================
...
  - GET http://localhost:3000/api/health did not respond within 3000ms
  - LOAD_TEST_WORKSPACE_IDS is not set
...
```

Once an API + PostgreSQL is running:

```
LOAD_TEST_API_BASE_URL=http://localhost:3000 \
LOAD_TEST_WORKSPACE_IDS=<uuid1>,<uuid2>,<uuid3>,<uuid4>,<uuid5> \
  pnpm test:load:phase2
```

## Build provenance (SLSA 1.2 Build Level 1)

`.github/workflows/provenance.yml` builds the Phase 2 web and API artifacts on `main` and on
version tags and generates SLSA provenance via
[`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance)
(GitHub artifact attestation), satisfying SLSA 1.2 Build Level 1 (scripted build, provenance
available, distributed by the build service).

**This document does not fabricate a workflow run.** The table below is filled in from the
first real run of `provenance.yml` on `main`; until that run exists, this section is a
documented, explicit gap — not a silent claim of compliance — per the compliance matrix's
own instruction that Task 13 record the workflow run, subject digest, source commit,
builder identity, and verification command before a SLSA claim is made.

| Field                     | Value                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow run              | _pending first run on `main` — fill in the Actions run URL_                                                                                                              |
| Source commit             | _pending — fill in the commit SHA the run built from_                                                                                                                    |
| Subject (artifact) digest | _pending — fill in the `sha256:...` digest `attest-build-provenance` reports_                                                                                            |
| Builder identity          | `https://github.com/actions/runner` via `github.com/actions/attest-build-provenance@v2`, `workflow_ref: <owner>/<repo>/.github/workflows/provenance.yml@refs/heads/main` |
| Verification command      | `gh attestation verify <artifact-path-or-oci-ref> --owner <owner>`                                                                                                       |

To fill this table in after the workflow's first run: open the run in GitHub Actions, copy
its URL and the commit SHA it checked out, then run the verification command above against
the built artifact (or `gh attestation verify` against the same digest shown in the run's
"Attest build provenance" step summary) and record the digest it confirms.

## What Phase 2 explicitly does NOT claim

- **P0-08's complete thirty-minute workload (SPEC §40.3).** `tests/load/autosave-conflict.ts`
  is a ten-minute autosave/CAS-only profile. It does not exercise search or asset upload, and
  must never be reported as satisfying P0-08.
- **P0-14's cross-browser matrix (SPEC §41).** Every test in this evidence set runs Chrome
  only (`playwright.config.ts`'s single `devices["Desktop Chrome"]` project). Firefox,
  Safari, and Edge are not covered.
- **Full session-gated E2E coverage**: typing, mode switching, note open/save, offline/online
  retry, reload draft recovery, two-tab takeover, 409 conflict resolution, soft-delete
  restore, and checkpoint/version restore all have `.skip()`ed E2E stubs, not passing E2E
  coverage, because `WorkbenchPage.vue` does not yet wire a `sessionFactory` to a running
  API. Each stub names the exact assertions to add and the existing component/API-integration
  test it should match.
- **Full SPEC §40 performance evidence.** All four PERF-UI gates, the continuous-typing
  long-task gate, and the §40.4 API-sampling gates are `.skip()`ed pending the reference
  Docker Compose environment; only the percentile-math harness itself is proven today.
  `GET search` and export performance are outside Phase 2 entirely and are not stubbed.
- **A completed SLSA attestation.** The provenance workflow exists and is correct, but no
  run has produced a recorded digest yet (see the table above).
- **The manual VoiceOver/NVDA smoke test (SPEC §41).** `accessibility.spec.ts`'s "screen
  reader smoke" test is the automatable proxy (accessibility-tree structure), not a
  substitute for actually running VoiceOver or NVDA through the core flow by hand. That
  manual pass is still a release-evidence gate to run and record separately.
- **The `EditorTabs.vue` nested-interactive accessibility finding is not fixed** (see above)
  — it is a recorded, trip-wired exception, not a pass.

## Running everything

```
pnpm test:e2e              # tests/e2e/**/*.spec.ts + tests/performance/**/*.perf.spec.ts
pnpm test:load:phase2      # tests/load/autosave-conflict.ts
pnpm test:phase2           # typecheck, lint, format:check, build, unit, cross-package, integration, e2e
```

CI (`.github/workflows/ci.yml`) installs Chromium and runs the full `tests/e2e` +
`tests/performance` suite (all of the above included, `.skip()`s reported as skipped, not
failed) on every push/PR to `main`. `.github/workflows/provenance.yml` runs the SLSA
provenance build separately on `main` and release tags.
