# Phase 1 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Phase 1 document engine merge-ready by closing every reproduced source-preservation, version-rejection, directive-fidelity, and registry-reservation blocker.

**Architecture:** Parsing returns a discriminated accepted/rejected result that always retains canonical source. Directive recovery preserves kind and converts structurally invalid parents into lossless invalid blocks. Reserved built-ins are installed through an internal capability while public registration rejects shadowing.

**Tech Stack:** Node.js 22+, TypeScript strict, unified/remark, Zod, Vitest, fast-check, pnpm.

## Global Constraints

- Canonical state remains UTF-8 Markdown; rejected input must remain byte-for-byte available as `ParseResult.source`.
- No DOM, Vue, Milkdown, CodeMirror, Tailwind, or Hono dependency.
- Unsupported future versions must not produce a v1 semantic document.
- No directive or invalid child may silently change kind or lose content.
- Unknown built-in attributes use the documented v0.1 strip policy; no universal `ATTRIBUTE_UNKNOWN` diagnostic is added.
- Every production-code change follows a witnessed RED test, minimal GREEN implementation, and refactor with tests green.
- Commit format is `<type>: <description>` with no attribution footer.
- Tasks execute strictly in numeric order. Each executor owns every file named by its task until its commit and review are complete; ownership then returns to the main session before the next task starts. No implementation tasks run in parallel.

---

### Task 1: Lossless parse-result and rejection boundary

**Files:**
- Modify: `packages/document-engine/src/parser/index.ts`
- Modify: `packages/document-engine/src/parser/mdast.ts`
- Modify: `packages/document-engine/src/parser/frontmatter.test.ts`
- Modify: `packages/document-engine/src/parser/mdast.test.ts`
- Modify: `packages/document-engine/src/parser/transform.test.ts`
- Modify: `packages/document-engine/src/engine.test.ts`
- Modify: `packages/document-engine/src/__tests__/round-trip.test.ts`
- Modify: `packages/document-engine/src/__tests__/property.test.ts`
- Modify: `packages/document-engine/src/__tests__/fixtures.test.ts`
- Modify: `packages/document-engine/src/serializer/to-mdast.test.ts`
- Modify: `packages/document-engine/src/validation/diagnostics.ts`
- Modify: `docs/superpowers/specs/2026-08-20-phase1-document-engine-design.md`
- Modify: `packages/document-engine/tests/fixtures/version/{missing-version-marker,invalid-version-non-positive,invalid-version-non-integer,unsupported-future-version}/expected.ast.json` to contain `null`
- Delete: `packages/document-engine/tests/fixtures/version/{missing-version-marker,invalid-version-non-positive,invalid-version-non-integer,unsupported-future-version}/expected.md`

**Interfaces:**
- Produces `ParseResult = AcceptedParseResult | RejectedParseResult`.
- Both variants expose `source`, `diagnostics`, and `specVersion`.
- Accepted: `ok: true; document: NotebookDocument`.
- Rejected: `ok: false; document: null`.

- [ ] **Step 1: Write failing parse-result tests**

Add tests proving: valid v1 returns `ok: true` and exact `source`; future v2
returns `ok: false`, `document: null`, exact `source`, and
`UNSUPPORTED_SPEC_VERSION`; `importLegacy` retains CRLF/trailing spaces and
rejects non-positive or future assumed versions; a malformed block-directive
attribute opener such as `:::callout{type="warning"` returns `ok: false`, exact
source, and `DIRECTIVE_SYNTAX_INVALID`.

Add negative classifier cases proving acceptance of ordinary `:::` prose,
escaped `\:::callout{`, closing-fence-like lines, colon text inside blockquotes
and lists, fenced code, and inline code. Inject a throwing MDAST parser into the
internal parse adapter and assert a deterministic rejected result with exact
source and `DIRECTIVE_SYNTAX_INVALID`.

Version outcomes are binding: ordinary `parse` rejects missing markers,
malformed YAML, non-positive and non-integer values, and future versions;
`importLegacy(versionless, 1)` accepts and removes only the expected
`SPEC_VERSION_MISSING` diagnostic.

- [ ] **Step 2: Run RED tests**

Run: `pnpm --filter @glyphquire/document-engine test -- parser engine`
Expected: failures show missing `ok`/`source`, v2 producing a v1 document, and
missing malformed-directive rejection.

- [ ] **Step 3: Implement the discriminated result**

Add `DIRECTIVE_SYNTAX_INVALID`. Make the MDAST layer return an explicit parse
failure instead of an empty root and expose an internal parser dependency seam
for the deterministic failure test. The malformed classifier examines only
top-level paragraph source lines that begin (after at most three spaces) with
`::name{` or `:::name{` and lack `}` on that line; it ignores escaped openers
and all non-paragraph/nested/code nodes. Stop before semantic transform for
missing/invalid/future version, parser failure, or bounded malformed directive.
Validate the legacy assumed version before accepting it. Update call sites and tests to
narrow on `result.ok` before accessing `document`. `importLegacy` removes the
expected `SPEC_VERSION_MISSING` warning after applying a valid explicit legacy
policy; it retains any unrelated diagnostics. Update the fixture harness in
this task so rejected fixtures assert `document: null` and exact `source`
without attempting serialization.

- [ ] **Step 4: Run GREEN tests and typecheck**

Run: `pnpm --filter @glyphquire/document-engine test -- parser engine`
Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test`
Expected: all three exit 0. Update the version golden fixtures in this task so
the package suite never carries intentionally failing fixtures between commits.

- [ ] **Step 5: Update the governing Phase 1 API text and commit**

Document the discriminated result and rejection behavior in the Phase 1 design.
Commit: `fix: preserve source across parse rejection`

---

### Task 2: Preserve directive kind and invalid children

**Files:**
- Modify: `packages/document-engine/src/ast/nodes.ts`
- Modify: `packages/document-engine/src/registry/types.ts`
- Modify: `packages/document-engine/src/parser/transform.ts`
- Modify: `packages/document-engine/src/serializer/to-mdast.ts`
- Modify: `packages/document-engine/src/registry/blocks/tabs.ts`
- Modify: `packages/document-engine/src/registry/blocks/columns.ts`
- Modify: `packages/document-engine/src/parser/transform.test.ts`
- Modify: `packages/document-engine/src/serializer/to-mdast.test.ts`
- Modify: `packages/document-engine/src/validation/validate.ts`
- Modify: `packages/document-engine/src/validation/validate.test.ts`
- Modify: `packages/document-engine/src/validation/diagnostics.ts`
- Modify: invalid-child fixture expectations under `packages/document-engine/tests/fixtures/{tabs,columns}/invalid-child/`

**Interfaces:**
- `InvalidBlockNode` records `directiveType` for directive-origin failures.
- A typed domain validation error carries diagnostic issues and already transformed children from a block definition to the generic transformer.

- [ ] **Step 1: Write failing fidelity tests**

Test that an unknown leaf serializes back as a leaf; a leaf-form built-in is
reported with error code `DIRECTIVE_KIND_MISMATCH` and retains leaf form; an
unknown inline text directive round-trips inside its paragraph; tabs/columns
with a sentinel foreign paragraph emit exactly one `INVALID_CHILD`, no false
`INVALID_PARENT`, and the serialized Markdown still contains the sentinel.

- [ ] **Step 2: Run RED tests**

Run: `pnpm --filter @glyphquire/document-engine test -- transform to-mdast`
Expected: unknown/built-in leaf forms become containers and invalid-child
sentinels disappear.

- [ ] **Step 3: Implement lossless directive recovery**

Serialize unknown and invalid directives according to their recorded kind.
Check `directiveTypeOf(node)` against `BlockDefinition.kind` before invoking a
known definition and emit `DIRECTIVE_KIND_MISMATCH` at error severity.
Introduce a domain validation error so tabs/columns can reject
their shape while returning all transformed children to `InvalidBlockNode`.
Teach semantic validation to traverse retained children with their recovered
parent scope. Emit one diagnostic per violation without double-transforming
children or adding false standalone-parent errors.

- [ ] **Step 4: Run GREEN tests and package gate**

Run: `pnpm --filter @glyphquire/document-engine test -- transform to-mdast`
Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test`
Expected: all three exit 0. Update invalid-child golden fixtures in this task.

- [ ] **Step 5: Commit**

Commit: `fix: preserve invalid directive structure`

---

### Task 3: Enforce built-in registry reservation

**Files:**
- Modify: `packages/document-engine/src/registry/registry.ts`
- Modify: `packages/document-engine/src/registry/builtins.ts`
- Modify: `packages/document-engine/src/registry/registry.test.ts`
- Modify: `docs/superpowers/specs/2026-08-20-phase1-document-engine-design.md`

**Interfaces:**
- Public `register(definition)` rejects reserved names.
- Default built-in installation uses a module-internal token that is not re-exported by `src/registry/index.ts` or `src/index.ts`.

- [ ] **Step 1: Write the failing reservation test**

Create a fresh registry and assert that registering a fake definition named
`callout` throws, while a non-reserved name can still be registered. Retain the
test that `createRegistry()` contains every built-in.

- [ ] **Step 2: Run RED test**

Run: `pnpm --filter @glyphquire/document-engine test -- registry`
Expected: fake `callout` registration succeeds, causing the new assertion to fail.

- [ ] **Step 3: Implement internal built-in registration**

Add a module-private capability token accepted only by the built-in assembly
path. Reject reserved names from ordinary `register()`. Do not export the token
through the package public surface. Correct the governing design sentence to
state that public registration rejects reserved names; non-reserved registry
entries remain structurally supported although declarative custom blocks are a
Phase 1 non-goal.

- [ ] **Step 4: Run GREEN test and typecheck**

Run: `pnpm --filter @glyphquire/document-engine test -- registry`
Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test`
Expected: all three exit 0.

- [ ] **Step 5: Commit**

Commit: `fix: prevent built-in block shadowing`

---

### Task 4: Make golden fixtures assert recovery behavior

**Files:**
- Modify: `packages/document-engine/src/__tests__/fixtures.test.ts`
- Create: selected `expected.diagnostics.json` files under `packages/document-engine/tests/fixtures/`
- Modify: `docs/MARKDOWN_SPEC.md`
- Modify: `docs/superpowers/specs/2026-08-20-phase1-document-engine-design.md`

**Interfaces:**
- Fixture harness optionally reads `expected.diagnostics.json` as an ordered list of diagnostic codes.
- Rejected fixtures assert `document: null` and never assert a synthesized canonical Markdown output.

- [ ] **Step 1: Write failing harness/fixture assertions**

Add expected diagnostic codes for unsupported future version, invalid child,
invalid attribute, and missing/invalid version fixtures. Tasks 1 and 2 already
own the corresponding AST/Markdown behavior changes; this task makes their
diagnostic contract fixture-driven.

- [ ] **Step 2: Run RED fixture suite**

Run: `pnpm --filter @glyphquire/document-engine test -- fixtures`
Expected: the old harness ignores or mishandles the new recovery expectations.

- [ ] **Step 3: Implement diagnostic-aware fixture handling**

Assert diagnostics when the optional file exists. For `ok: false`, assert
`document: null`, exact source, and absence of `expected.md`; for `ok: true`,
continue normalized AST and canonical Markdown assertions. Document v0.1 built-in unknown attributes as
schema-stripped without mandatory diagnostics.

- [ ] **Step 4: Run GREEN fixture and round-trip suites**

Run: `pnpm --filter @glyphquire/document-engine test -- fixtures round-trip property`
Expected: exit 0 with all recovery assertions exercised.

- [ ] **Step 5: Commit**

Commit: `test: assert document recovery diagnostics`

---

### Task 5: Whole-branch verification

**Files:** No production changes unless verification exposes a regression.

- [ ] **Step 1: Run package and workspace gates**

Run: `pnpm --filter @glyphquire/document-engine test`
Run: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`
Run: `git diff --check main...HEAD`
Expected: every command exits 0; document-engine reports zero failed tests.

- [ ] **Step 2: Re-run the six review counterexamples**

Verify rejected future input retains v2 source, unknown leaf kind is stable,
invalid child sentinels survive, malformed directives reject with source,
reserved shadow registration throws, and legacy CRLF/trailing spaces remain in
`ParseResult.source`.

- [ ] **Step 3: Fresh verifier and final review**

Require `CONFIRMED` from a fresh outcome verifier and no Critical/Important
findings from the final whole-branch review before presenting merge options.
