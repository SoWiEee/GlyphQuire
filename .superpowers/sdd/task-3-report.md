# Task 3 Report: Persist User Theme Preferences

## Summary

- Added the `user_preferences` table and generated Drizzle migration `0012_user_preferences.sql` with matching journal/snapshot metadata.
- Added strict shared contracts for complete theme preference writes and the exact public response shape.
- Added authenticated `GET`/`PUT /api/v1/me/preferences/theme` routes and app wiring.
- Added user-scoped reads, stable non-writing defaults, system-theme-only validation, revision-zero insertion, and atomic user/revision CAS updates.
- Added contract, route, and PostgreSQL service tests for invalid inputs, unauthenticated access, actor isolation, first write, stale revisions, and workspace-theme rejection.

## Security decisions

- Actor identity is read only from the authenticated request context; query parameters and body identity fields are rejected.
- Preference records are keyed by the authenticated user and never require or accept a workspace identifier.
- Theme selection accepts only globally scoped rows marked as system themes; workspace theme identifiers fail with the scrubbed invalid-request envelope.
- Writes use insert-on-conflict for revision `0` and a single `user_id` plus `revision` predicate for later CAS updates.
- Overrides reuse the existing bounded theme token and component variant schemas, with strict unknown-key rejection at the API boundary.

## Verification

- `pnpm --filter @glyphquire/api-contract typecheck` — passed.
- `pnpm --filter @glyphquire/database typecheck` — passed.
- `pnpm --filter @glyphquire/api typecheck` — passed.
- `pnpm --filter @glyphquire/api-contract exec vitest run src/preferences/schemas.test.ts --config /dev/null` — 3 tests passed.
- `TEST_DATABASE_URL=<isolated-local-db> pnpm --filter @glyphquire/api exec vitest run src/modules/preferences/UserPreferenceService.integration.test.ts src/routes/v1/preferences.integration.test.ts --config vitest.integration.config.ts` — 9 tests passed.
- Focused `oxlint` on Task 3 sources — passed.
- `oxfmt --write` on Task 3 TypeScript sources — completed.

## Commit

- Message: `Add persisted user theme preferences`
