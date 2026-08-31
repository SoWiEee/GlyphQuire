# Phase 5 browser and accessibility evidence

Automated coverage is in `tests/e2e/phase5.spec.ts` and
`tests/e2e/phase5-accessibility.spec.ts`. The latter scopes axe WCAG A/AA scans
to each Phase 5 modal and exercises keyboard-only command selection, initial
focus, Escape close/focus restoration, labelled controls, live/error output,
and rejection of an SVG payload without DOM rendering.

Local execution on 2026-08-30: the repository's configured Playwright Desktop
Chrome project ran all five Phase 5 tests with one worker; **5 passed in 6.0
seconds** (three scoped axe/keyboard cases and two browser-adapter acceptance
cases). This confirms the checked-in bundled-Chrome harness, not the required
latest-two-stable matrix or real API/object-store stack.

| Required target         | Version/build | Result  | Evidence                       |
| ----------------------- | ------------- | ------- | ------------------------------ |
| Chrome latest stable    | Not recorded  | Blocked | Release CI/manual run required |
| Chrome previous stable  | Not recorded  | Blocked | Release CI/manual run required |
| Firefox latest stable   | Not recorded  | Blocked | Release CI/manual run required |
| Firefox previous stable | Not recorded  | Blocked | Release CI/manual run required |
| Safari latest stable    | Not recorded  | Blocked | Manual/macOS run required      |
| Safari previous stable  | Not recorded  | Blocked | Manual/macOS run required      |
| Edge latest stable      | Not recorded  | Blocked | Release CI/manual run required |
| Edge previous stable    | Not recorded  | Blocked | Release CI/manual run required |
| VoiceOver core flow     | Not recorded  | Blocked | Manual/macOS smoke required    |
| NVDA core flow          | Not recorded  | Blocked | Manual/Windows smoke required  |

The deterministic Chrome adapter uses mocked same-origin API responses and must
not be reported as PostgreSQL/MinIO full-stack evidence. Playwright/axe cannot
substitute for an actual screen reader. Record browser versions, operating
systems, timestamps, flow, failures, and immutable artifact links after the
manual/release-CI runs; do not paste note or token contents.

Phase 6 adds an explicit local Playwright diagnostic matrix (`chromium`,
`msedge`, `firefox`, and `webkit`) plus a credential-free BrowserStack
capability template. Local WebKit is never counted as Safari evidence; the
eight-provider target result is written to
`docs/evidence/phase6/browser-matrix.json` only after BrowserStack resolves
every requested capability and returns numeric session metadata.
