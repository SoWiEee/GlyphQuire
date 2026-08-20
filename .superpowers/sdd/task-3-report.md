# Task 3 Report: Enforce built-in registry reservation

## Files

- `packages/document-engine/src/registry/registry.ts`
- `packages/document-engine/src/registry/builtins.ts`
- `packages/document-engine/src/registry/registry.test.ts`
- `docs/superpowers/specs/2026-08-20-phase1-document-engine-design.md`

## RED/GREEN evidence

- RED: `pnpm --filter @glyphquire/document-engine test -- registry` exited 1;
  the new reserved-`callout` assertion failed while the suite reported 9/10
  tests passing.
- GREEN: the same focused command exited 0 with 2 files and 10/10 tests
  passing.
- Typecheck: `pnpm --filter @glyphquire/document-engine typecheck` exited 0.
- Full package suite: `pnpm --filter @glyphquire/document-engine test` exited 0
  with 17 files and 144/144 tests passing.
- Diff check: `git diff --check` exited 0.

## Public-export self-check

The internal registration helper and token names are absent from both
`packages/document-engine/src/registry/index.ts` and
`packages/document-engine/src/index.ts`; the self-check exited 0.

## Commit

`fix: prevent built-in block shadowing`

## Concerns

None.
