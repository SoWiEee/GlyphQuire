# Icons, Theme Persistence, and Custom Blocks Release Report

## Scope

The shared Lucide icon contract, persisted user theme preferences, and
workspace-scoped declarative Custom Blocks are implemented. Custom Block
definitions are validated through the shared theme SDK, rendered through the
existing safe registry boundary, and preserved as canonical Markdown
directives when a definition is unavailable.

## Persistence and safety

Custom Block mutations require membership authorization, owner/editor access,
an operation ID, and compare-and-swap revision. Published versions remain
immutable. Migration `0015_custom_block_operations` records an immutable,
request-hashed operation history keyed by actor, workspace, and operation ID;
the target block identity remains available after a whole-block draft delete so
retries are idempotent without replaying a mutation.

## Verification

- `pnpm typecheck` — passed
- `pnpm lint` — passed
- `pnpm build` — passed
- database and API package suites — passed after the migration expectation was
  updated; PostgreSQL integration suites remain environment-gated
- focused Custom Block web/API tests — passed
- `pnpm exec oxfmt --check` on all touched files — passed

The repository-wide format check still reports three pre-existing, untracked
user planning documents outside this change. They were not modified or staged.
