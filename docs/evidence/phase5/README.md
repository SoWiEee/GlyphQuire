# Phase 5 release evidence

Status on 2026-08-30: **BLOCKED — implementation and deterministic harnesses are
present, but external P0 evidence is incomplete.** This directory records only
observed results; absence never means pass.

| Gate                                         | Current evidence                                                 | Status                                      |
| -------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| Shared contracts/client/component acceptance | API 7 passed; web 43 focused passed on 2026-08-30                | Green locally                               |
| Five-actor search freshness                  | `apps/api/src/search-freshness.integration.test.ts`              | Blocked locally: `TEST_DATABASE_URL` absent |
| Deterministic Chrome browser-adapter flow    | Phase 5 Playwright + axe/keyboard suites: 5 passed on 2026-08-30 | Green locally                               |
| PostgreSQL + MinIO Chrome full-stack flow    | Deterministic browser coverage is not full-stack evidence        | Blocked: real full-stack run not captured   |
| 30-minute/five-user §40.3 profile            | `tests/load/phase5-product-services.ts`                          | Blocked: load environment/results absent    |
| Alert delivery within five minutes           | Validator: 2 passed; external capture: 1 skipped                 | Blocked: operator-channel capture absent    |
| Latest-two browser matrix                    | See `browser-accessibility.md`                                   | Blocked: release-browser results absent     |
| VoiceOver or NVDA core-flow smoke            | See `browser-accessibility.md`                                   | Blocked: manual result absent               |
| Migration/frozen install/full root gates     | Release CI transcript required                                   | Blocked: not captured here                  |

The deterministic Playwright suite uses strict route fixtures to verify browser
request construction, response validation, logical `asset://` references,
stable permission errors, and share revocation. It does not claim that the
database, worker, object store, or operator channel passed.

Evidence must not contain session cookies, bearer tokens, webhook URLs,
credentials, presigned query strings, Markdown bodies, imported archives, or
provider diagnostics. Store immutable CI/artifact references and sanitized
counters instead.
