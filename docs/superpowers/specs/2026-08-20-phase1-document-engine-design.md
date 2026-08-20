# Phase 1 — Document Engine Design

> Status: Approved for planning
> Date: 2026-08-20
> Scope: SPEC.md §44 Phase 1, §7 Document Engine; MARKDOWN_SPEC.md v0.1
> Source of truth: MARKDOWN_SPEC.md (grammar/AST/serialization) > SPEC.md (architecture)

## 1. Goal

Build `@glyphquire/document-engine`: a pure TypeScript library that owns the
full lifecycle of canonical Notebook Markdown — parse, validate, serialize,
migrate, and text extraction — with zero browser/DOM dependencies.

This phase delivers the grammar/AST/serializer contract that Phase 2 (editors),
Phase 3 (renderer/theme), and Phase 4 (runtime) build on. Per MARKDOWN_SPEC.md
§64, the engine must be verifiable through a pure `parse → AST → validate →
serialize → parse` round-trip before any visual component work.

## 2. Non-goals (this phase)

- Milkdown / CodeMirror integration (Phase 2)
- Rendering to DOM / Vue components (Phase 3)
- Runtime **execution** of p5/canvas source (Phase 4). This phase parses and
  serializes `RuntimeNode` and preserves its `source` string, but never
  evaluates it.
- Declarative custom blocks (§29–31): deferred. Unknown directives already
  round-trip via `UnknownDirectiveNode`, so documents authored against a future
  custom-block feature survive parse/serialize without data loss.
- Asset resolution to signed URLs (Phase 5). The engine preserves `asset://`
  logical URIs verbatim.
- Import adapters (Obsidian, generic Markdown export). Only canonical Notebook
  Markdown parse/serialize is in scope.

## 3. Global Constraints

Copied from the governing specs; every task inherits these.

- **Node.js 22+, TypeScript strict mode**, ES2022, ESNext modules, matching the
  Phase 0 `tsconfig.base.json`.
- **Zero DOM/framework dependency**: the package MUST NOT import Vue, Milkdown,
  CodeMirror, Tailwind, Hono, or any DOM API. (SPEC.md §7)
- **Canonical source is UTF-8 Markdown text.** MDAST and Semantic AST are
  derived, never canonical. (MARKDOWN_SPEC.md §3)
- **Preserve source over perfect rendering.** `parse` MUST NOT crash on
  arbitrary UTF-8; malformed input yields diagnostics + preserved source, never
  a thrown exception or silent data loss. (§26 principle, §42, §55)
- **Registry is the single source of block knowledge.** Parser and serializer
  resolve every directive through the Component Registry; adding a block means
  adding a `BlockDefinition`, not editing parser/serializer. (§17, §18)
- **Serialize via the directive serializer**, never string concatenation of
  directive/attribute text. (§12, §34)
- **Round-trip invariant** (§36): `semanticNormalize(parse(M)) ===
  semanticNormalize(parse(serialize(parse(M))))`. Byte-identical output is not
  required.
- **Spec version marker** `glyphquire-spec` (positive integer) lives in YAML
  frontmatter; `parse` reads it, serialize retains it, unsupported future
  versions are rejected without destructive guessing. (§47, §55)
- Built-in directive names are reserved and MUST NOT be shadowed. (§19)

## 4. Library Stack

Chosen: the **unified/remark ecosystem** (ADR-01/02, refined 2026-08-20).

| Concern | Library |
|---------|---------|
| Markdown → MDAST | `unified` + `remark-parse` |
| GFM (tables, strikethrough, task lists, autolinks, footnotes) | `remark-gfm` |
| Generic directives (`:::name{attrs}`) | `remark-directive` (+ `mdast-util-directive`) |
| Frontmatter (`glyphquire-spec` YAML) | `remark-frontmatter` |
| YAML value parsing | `yaml` |
| MDAST → Markdown | `mdast-util-to-markdown` with GFM/directive/frontmatter extensions |
| Prop schema validation | `zod` (existing project dependency) |
| Tests | `vitest` |

Rejected alternative: hand-writing micromark extensions. Higher cost, reinvents
the directive/attribute tokenizer the spec already assumes, and forfeits the
maintained `mdast-util-*` serializers the round-trip invariant depends on.

## 5. Module Structure

Single package, internally modular. Files stay focused (<400 lines target).

```
packages/document-engine/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                 # public API surface (§6)
    ast/
      nodes.ts               # Semantic AST types: NotebookDocument, BlockNode
                             #   union, inline nodes, all block node interfaces
      normalize.ts           # semanticNormalize() for round-trip comparison
      index.ts
    registry/
      types.ts               # BlockDefinition, TransformContext,
                             #   SerializeContext, BlockCapability
      registry.ts            # BlockRegistry: register/lookup, reserved-name guard
      blocks/
        callout.ts           # §20
        sticky.ts            # §21
        toggle.ts            # §22
        tabs.ts              # §23 (tabs + tab)
        columns.ts           # §24 (columns + column)
        runtime.ts           # §25–26 (p5 + canvas → RuntimeNode)
      builtins.ts            # assembles the default registry
      index.ts
    parser/
      mdast.ts               # unified pipeline: markdown → MDAST
      frontmatter.ts         # extract + validate glyphquire-spec version
      transform.ts           # MDAST → Semantic AST (registry-driven);
                             #   unknown/invalid handling
      index.ts               # parse(), importLegacy()
    serializer/
      to-mdast.ts            # Semantic AST → MDAST (registry-driven)
      to-markdown.ts         # MDAST → Markdown string; fence-length + formatting
      index.ts               # serialize()
    validation/
      diagnostics.ts         # DocumentDiagnostic, ValidationIssue, code constants
      validate.ts            # parent/child + required-attr semantic validation
      index.ts
    migration/
      types.ts               # MigrationResult, Migration
      migrate.ts             # migrateDocument, version guards, snapshot hook
      registry.ts            # migration registry (v1 identity)
      index.ts
    text/
      extract.ts             # extractText() / search-text extraction (§43)
      index.ts
  tests/
    fixtures/                # golden fixtures per §59
    round-trip.test.ts
    property.test.ts
    ...co-located unit tests per module
```

## 6. Public API

Aligned to SPEC.md §7.2 `DocumentEngine` interface. The package exports both a
functional surface and a `createDocumentEngine(registry?)` factory.

```ts
type ParseResult = AcceptedParseResult | RejectedParseResult;

interface AcceptedParseResult {
  ok: true;
  document: NotebookDocument;
  source: string;
  diagnostics: DocumentDiagnostic[];
  specVersion: number;
}

interface RejectedParseResult {
  ok: false;
  document: null;
  source: string;
  diagnostics: DocumentDiagnostic[];
  specVersion: number | null;
}

interface ValidationResult {
  valid: boolean;
  diagnostics: DocumentDiagnostic[];
}

interface MigrationResult {
  markdown: string;             // migrated output, or original on failure
  ok: boolean;
  fromVersion: number;
  toVersion: number;
  diagnostics: DocumentDiagnostic[];
  snapshot?: string;            // pre-migration source when destructive
}

interface DocumentEngine {
  parse(markdown: string): ParseResult;
  importLegacy(markdown: string, assumedVersion: number): ParseResult;
  validate(document: NotebookDocument): ValidationResult;
  serialize(document: NotebookDocument): string;
  migrate(markdown: string, from: number, to: number): MigrationResult;
  extractText(document: NotebookDocument): string;
}

function createDocumentEngine(registry?: BlockRegistry): DocumentEngine;
function createRegistry(): BlockRegistry;   // default registry with all built-ins
```

`parse` reads `glyphquire-spec` from canonical frontmatter. Missing, malformed,
non-positive, non-integer, and unsupported future markers are rejected with
`ok: false`, `document: null`, and the exact original Markdown in `source`.
Unsupported future versions and parser failures never get transformed into a
v1 AST. Only the explicitly named `importLegacy` accepts a validated
caller-selected version for versionless input; it preserves the exact source
and removes only the expected `SPEC_VERSION_MISSING` warning. A bounded
malformed top-level block-directive attribute opener is likewise rejected with
`DIRECTIVE_SYNTAX_INVALID`. (SPEC.md §7.2, MARKDOWN_SPEC.md §47)

## 7. Semantic AST

Root and block union per MARKDOWN_SPEC.md §16. `specVersion: 1`.

```ts
interface NotebookDocument {
  type: "document";
  specVersion: 1;
  children: BlockNode[];
}

type BlockNode =
  | ParagraphNode | HeadingNode | QuoteNode | ListNode | CodeNode
  | TableNode | ImageNode | ThematicBreakNode
  | CalloutNode | StickyNode | ToggleNode | TabsNode | TabNode
  | ColumnsNode | ColumnNode | RuntimeNode
  | UnknownDirectiveNode | InvalidBlockNode;
```

The AST MUST NOT contain Tailwind classes, Vue instances, DOM nodes,
ProseMirror/Milkdown state, or CSS. (§16)

`semanticNormalize(ast)` produces a canonical comparison form (strips
formatting-only fields, applies schema-defined attribute ordering, drops omitted
defaults) so the round-trip invariant compares meaning, not bytes.

## 8. Registry & Block Definitions

```ts
interface BlockDefinition<TNode extends BlockNode = BlockNode> {
  name: string;
  version: number;
  kind: "container" | "leaf" | "text";
  schema: ZodType;                                  // prop schema (§11.5 coercion)
  capabilities: BlockCapability[];                  // §44
  fromDirective(node: DirectiveMdastNode, ctx: TransformContext): TNode;
  toDirective(node: TNode, ctx: SerializeContext): DirectiveMdastNode;
}
```

Built-in definitions and their capabilities:

| Block | Directive | Capability | Notes |
|-------|-----------|-----------|-------|
| Callout | `callout` | `static` | type enum, optional title/icon (§20) |
| Sticky | `sticky` | `static` | tone enum, optional title (§21) |
| Toggle | `toggle` | `interactive-ui` | title required non-empty, open default false (§22) |
| Tabs/Tab | `tabs`/`tab` | `interactive-ui` | tab is direct child of tabs; ≥1 tab (§23) |
| Columns/Column | `columns`/`column` | `static` | count 2–4, gap enum (§24) |
| Runtime | `p5`/`canvas` | `sandbox-runtime` | preserves source string; no execution (§25–26) |

Reserved names (§19): `callout, sticky, toggle, tabs, tab, columns, column, p5,
canvas`. Public registry registration rejects these reserved names; non-reserved
registry entries remain structurally supported, although declarative custom
blocks are a Phase 1 non-goal.

Attribute handling (§11): string values coerced to schema type by the validator;
serializer emits double-quoted values in schema-defined deterministic order;
omits unambiguous defaults (e.g. `open="false"`). Built-in v0.1 schemas use an
explicit strip policy for unknown attributes: they are omitted from the
semantic AST and canonical output without a mandatory `ATTRIBUTE_UNKNOWN`
diagnostic. Future schemas may opt into reporting; the engine does not add
universal unknown-attribute detection.

## 9. Parser Behavior & Error Recovery

Three degradation paths (§14, §15, §42):

1. **Syntax-invalid** — directive parser cannot form a node: emit a syntax
   diagnostic, preserve raw Markdown in a rejected parse result, and do not
   crash. The bounded v0.1 classifier rejects only a top-level paragraph line
   beginning (after at most three spaces) with `::name{` or `:::name{` whose
   closing `}` is missing on that line; escaped openers, prose, nested nodes,
   and code are accepted.
2. **Unknown directive** — well-formed but name not in registry →
   `UnknownDirectiveNode` preserving `name`, `attributes`, `children`, and
   enough source for round-trip.
3. **Schema-invalid** — name resolves but props violate the block schema →
   `InvalidBlockNode` preserving `originalType`, original attributes, and
   `errors: ValidationIssue[]`.

A broken block MUST NOT remove unrelated document content. `parse` never throws
on arbitrary UTF-8 (property-tested).

## 10. Validation

`DocumentDiagnostic` per §41 with `code`, `severity`, `message`, optional
`range`, `block`, `attribute`. Diagnostic codes from §41: `DIRECTIVE_UNKNOWN`,
`DIRECTIVE_INVALID_NAME`, `DIRECTIVE_SYNTAX_INVALID`, `ATTRIBUTE_UNKNOWN`,
`ATTRIBUTE_INVALID_VALUE`, `ATTRIBUTE_REQUIRED`, `INVALID_PARENT`,
`INVALID_CHILD`, `UNSUPPORTED_SPEC_VERSION`. (`RUNTIME_NETWORK_DENIED`,
`ASSET_NOT_FOUND` are declared for later phases.)

Semantic validation covers: parent/child rules (`tab` only under `tabs`,
`column` only under `columns`, ≥1 tab), required attributes, enum membership,
and number bounds. Prop coercion uses each block's Zod schema.

## 11. Serialization

Per §34–35: valid Notebook Markdown, deterministic attribute order, omit
unambiguous defaults, sufficient directive fence length for nesting (outer fence
uses more colons than any inner — §13), preserve unknown directives and
`asset://` URIs, retain/emit `glyphquire-spec` frontmatter. Canonical
formatting: UTF-8, LF, ATX headings, backtick fences, double-quoted attributes,
trailing newline. Setext headings normalized to ATX. (§7, §35)

## 12. Migration Framework

```ts
function migrateDocument(markdown: string, from: number, to: number): MigrationResult;
```

Per §48: deterministic, preserves source on failure, produces diagnostics, has
fixtures, snapshots before destructive migration. A migration registry maps
`(from → to)` steps. v0.1 has only spec version 1, so the shipped content is:

- version detection + validation guards (reject non-positive, non-integer,
  unsupported future versions — §59 version fixtures),
- `migrate(v1 → v1)` identity (property-tested),
- the registry/snapshot scaffolding future versions plug into.

`importLegacy` is the only path that accepts a versionless/legacy document with
a caller-asserted version, and it preserves the original input in its result.

## 13. Text Extraction

`extractText` (§43) walks the Semantic AST collecting searchable text: heading,
paragraph, quote, list, callout title/content, sticky title/content, toggle
title/content, tab titles/content, image alt text. Excludes directive names,
theme tokens, runtime source, opaque asset IDs.

## 14. Testing Strategy

- **Golden fixtures** (§59): per built-in — `valid-minimal`, `valid-full`,
  `valid-nested`, `invalid-required-attribute`, `invalid-attribute-value`,
  `unknown-attribute`, `roundtrip`; parent/child blocks add `invalid-parent`,
  `invalid-child`; version handling adds `missing-version-marker`,
  `invalid-version-non-positive`, `invalid-version-non-integer`,
  `unsupported-future-version`, `metadata-version-mismatch`. Fixture shape:
  `input.md`, `expected.ast.json`, `expected.md`; the optional
  `expected.diagnostics.json` is an ordered list of diagnostic codes.
  Rejected fixtures assert a null document, exact source retention, and no
  canonical `expected.md`; accepted fixtures retain normalized AST and
  canonical Markdown assertions.
- **Round-trip** (§36): `semanticNormalize(parse(M)) ===
  semanticNormalize(parse(serialize(parse(M))))` across all fixtures.
- **Property tests** (§60): parse never crashes on arbitrary UTF-8;
  `serialize(parse(valid))` preserves semantics; `migrate(v1→v1)` is identity;
  migrate output is parseable; unknown directives survive parse/serialize.
- Runner: **Vitest**. Co-locate unit tests per module; cross-module round-trip
  and property suites under `tests/`.

## 15. Multi-Agent Execution Strategy

Single package, dependency-ordered waves with worktree isolation.

- **W1 (serial, foundation)** — package scaffold (`package.json`, `tsconfig`,
  `vitest.config`) + `ast/nodes` + `ast/normalize` + `registry/types` +
  `validation/diagnostics`. Pure type/contract layer everything else imports.
- **W2 (parallel)** — independent modules against the W1 contracts, disjoint
  directories:
  - `parser/mdast` + `parser/frontmatter`
  - `serializer/to-markdown` (MDAST → string, formatting, fence length)
  - `registry/blocks/*` + `registry/builtins` (all six block definitions)
  - `migration/*`
  - `text/extract`
- **W3 (serial, integration)** — registry-driven `parser/transform` and
  `serializer/to-mdast` wiring blocks + registry; the public `index.ts` API and
  `createDocumentEngine`. Needs W2 output stable.
- **W4 (verification)** — golden fixtures, round-trip harness, property tests;
  full-package typecheck + test gate; fresh-context review.

Each wave: typecheck + its own tests green before advancing. Final gate:
workspace-wide typecheck, lint, build, full test suite, and an
independent-review pass (round-trip + migration are risk-triggered:
serialization boundary + data-preservation invariant).

## 16. Acceptance

Phase 1 is complete when, per MARKDOWN_SPEC.md §55–60 and §64:

1. All six built-in blocks parse, validate, and serialize.
2. Unknown and invalid directives round-trip without data loss.
3. The round-trip invariant holds across all golden fixtures.
4. Version guards reject malformed/unsupported `glyphquire-spec` markers.
5. `migrate(v1→v1)` is identity and property tests pass.
6. `parse` never crashes on arbitrary UTF-8.
7. The package has zero DOM/framework dependencies.
8. Workspace typecheck, lint, build, and the full test suite pass.
