# Phase 1 — Document Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@glyphquire/document-engine`, a pure-TypeScript library that parses, validates, serializes, and migrates canonical Notebook Markdown with a stable round-trip guarantee.

**Architecture:** unified/remark pipeline produces MDAST; a registry-driven transform maps directive + standard MDAST nodes to a Notebook Semantic AST; a mirror serializer walks the Semantic AST back to MDAST and stringifies it. The Component Registry is the single source of block knowledge — adding a block means adding a `BlockDefinition`, never editing the parser or serializer.

**Tech Stack:** TypeScript strict, `unified` + `remark-parse` + `remark-gfm` + `remark-directive` + `remark-frontmatter` + `remark-stringify`, `mdast-util-directive`/`@types/mdast` (types), `mdast-util-to-string` (text extraction), `yaml`, `zod`, `vitest`, `fast-check`.

**Spec:** `docs/superpowers/specs/2026-08-20-phase1-document-engine-design.md` (argues from `docs/MARKDOWN_SPEC.md` v0.1 and `docs/SPEC.md` §7). Executors read the design spec; MARKDOWN_SPEC.md is the grammar authority.

## Global Constraints

- Node.js 22+, TypeScript strict mode, ES2022 target, ESNext modules, `moduleResolution: bundler`; extend the repo `tsconfig.base.json`. `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` are on — write code that satisfies them.
- Zero DOM/framework dependency: MUST NOT import Vue, Milkdown, CodeMirror, Tailwind, Hono, or any DOM API. MDAST types are allowed.
- Canonical source is UTF-8 Markdown text; MDAST and Semantic AST are derived, never canonical.
- `parse` MUST NOT throw on arbitrary UTF-8 input. Malformed input yields diagnostics + preserved source, never a thrown exception or silent data loss.
- Registry is the single source of block knowledge; parser/serializer resolve every directive through it.
- Serialize via the unified/directive serializer, never string concatenation of directive/attribute text.
- Round-trip invariant: `semanticNormalize(parse(M).document) ` deep-equals `semanticNormalize(parse(serialize(parse(M).document)).document)`. Byte-identical output is NOT required.
- Spec version marker `glyphquire-spec` (positive integer) lives in YAML frontmatter; `parse` reads it, serialize retains it, unsupported future versions are rejected without destructive guessing.
- Built-in directive names are reserved: `callout, sticky, toggle, tabs, tab, columns, column, p5, canvas`. They MUST NOT be shadowed.
- Package directory is `kebab-case`; functions/variables `camelCase`; types/interfaces `PascalCase`; constants `UPPER_SNAKE_CASE`.
- Commit format: `<type>: <description>` (feat, fix, test, docs, chore, refactor). No attribution footer.
- After each task, `pnpm --filter @glyphquire/document-engine typecheck` and the task's `vitest` run MUST pass.

## Package Layout (target)

```
packages/document-engine/
  package.json
  tsconfig.json            # typecheck config (includes tests in src/)
  tsconfig.build.json      # build config (excludes *.test.ts)
  vitest.config.ts
  src/
    index.ts               # public API (Task 11)
    ast/
      nodes.ts             # Task 2
      normalize.ts         # Task 2
      index.ts
    registry/
      types.ts             # Task 3
      registry.ts          # Task 6
      builtins.ts          # Task 6
      blocks/{callout,sticky,toggle,tabs,columns,runtime}.ts  # Task 6
      index.ts
    parser/
      mdast.ts             # Task 4
      frontmatter.ts       # Task 4
      transform.ts         # Task 9
      index.ts             # Task 9 (parse, importLegacy)
    serializer/
      to-markdown.ts       # Task 5
      to-mdast.ts          # Task 10
      index.ts             # Task 10 (serialize)
    validation/
      diagnostics.ts       # Task 3
      validate.ts          # Task 9
      index.ts
    migration/
      types.ts             # Task 7
      migrate.ts           # Task 7
      index.ts
    text/
      extract.ts           # Task 8
      index.ts
    __tests__/
      round-trip.test.ts   # Task 13
      property.test.ts     # Task 13
      fixtures.test.ts     # Task 12
  tests/
    fixtures/**            # Task 12 (data: input.md / expected.ast.json / expected.md)
```

## Wave / Dependency Map

- **W1 (serial):** Task 1 → Task 2 → Task 3 (foundation contracts).
- **W2 (parallel, own worktrees, depend only on W1):** Task 4, Task 5, Task 6, Task 7, Task 8.
- **W3 (serial, depends on W2):** Task 9 (needs Task 6), Task 10 (needs Task 5 + Task 6), Task 11 (needs 9 + 10).
- **W4 (serial, depends on W3):** Task 12, Task 13.

---

### Task 1: Package scaffold

**Files:**

- Create: `packages/document-engine/package.json`
- Create: `packages/document-engine/tsconfig.json`
- Create: `packages/document-engine/tsconfig.build.json`
- Create: `packages/document-engine/vitest.config.ts`
- Create: `packages/document-engine/src/index.ts`
- Create: `packages/document-engine/src/__tests__/scaffold.test.ts`
- Modify: root `package.json` (add `test` script)
- Modify: `.github/workflows/ci.yml` (add test step)

**Interfaces:**

- Produces: the `@glyphquire/document-engine` workspace package with `typecheck`, `build`, `test`, `clean` scripts. Later tasks add source under `src/`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@glyphquire/document-engine",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "types": "./src/index.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "unified": "^11.0.5",
    "remark-parse": "^11.0.0",
    "remark-stringify": "^11.0.0",
    "remark-gfm": "^4.0.0",
    "remark-directive": "^3.0.0",
    "remark-frontmatter": "^5.0.0",
    "mdast-util-directive": "^3.0.0",
    "mdast-util-to-string": "^4.0.0",
    "unist-util-visit": "^5.0.0",
    "yaml": "^2.5.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/mdast": "^4.0.4",
    "@types/node": "^22.0.0",
    "fast-check": "^3.22.0",
    "typescript": "^5.8.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`** (typecheck — includes test files in `src/`)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `tsconfig.build.json`** (build — no test files in output)

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/__tests__"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 5: Write placeholder `src/index.ts`**

```ts
// Public API is assembled in Task 11. Placeholder keeps the package typecheckable.
export const DOCUMENT_ENGINE_PACKAGE = "@glyphquire/document-engine";
```

- [ ] **Step 6: Write `src/__tests__/scaffold.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { DOCUMENT_ENGINE_PACKAGE } from "../index.js";

describe("scaffold", () => {
  it("exposes the package identity", () => {
    expect(DOCUMENT_ENGINE_PACKAGE).toBe("@glyphquire/document-engine");
  });
});
```

- [ ] **Step 7: Add `test` script to root `package.json`**

In the root `package.json` `scripts` object, add: `"test": "pnpm -r test"`.

- [ ] **Step 8: Add a test step to CI**

In `.github/workflows/ci.yml`, after the `build` step (or after `lint`), add a step:

```yaml
- name: Test
  run: pnpm -r test
```

- [ ] **Step 9: Install and verify**

Run: `pnpm install`
Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test`
Expected: install succeeds, typecheck clean, one passing test.

- [ ] **Step 10: Commit**

```bash
git add packages/document-engine package.json .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "feat: scaffold document-engine package"
```

---

### Task 2: Semantic AST types + normalize

**Files:**

- Create: `packages/document-engine/src/ast/nodes.ts`
- Create: `packages/document-engine/src/ast/normalize.ts`
- Create: `packages/document-engine/src/ast/index.ts`
- Create: `packages/document-engine/src/ast/normalize.test.ts`

**Interfaces:**

- Consumes: `@types/mdast` `PhrasingContent`, `AlignType`.
- Produces: `NotebookDocument`, `BlockNode` union and every node interface below; `InlineContent` (alias for mdast `PhrasingContent`); `semanticNormalize(document: NotebookDocument): NotebookDocument`.

Design note carried into every consumer: inline content of standard text blocks is retained as MDAST `PhrasingContent[]` (typed, DOM-free, round-trips through `mdast-util-to-markdown`). Only directive blocks get bespoke `props`.

- [ ] **Step 1: Write `src/ast/nodes.ts`**

```ts
import type { PhrasingContent, AlignType } from "mdast";

/** Inline content is retained as MDAST phrasing content for v0.1. */
export type InlineContent = PhrasingContent;

export interface NotebookDocument {
  type: "document";
  specVersion: 1;
  children: BlockNode[];
}

export type BlockNode =
  | ParagraphNode
  | HeadingNode
  | QuoteNode
  | ListNode
  | ListItemNode
  | CodeNode
  | TableNode
  | ImageNode
  | ThematicBreakNode
  | FootnoteDefinitionNode
  | DefinitionNode
  | CalloutNode
  | StickyNode
  | ToggleNode
  | TabsNode
  | TabNode
  | ColumnsNode
  | ColumnNode
  | RuntimeNode
  | UnknownDirectiveNode
  | InvalidBlockNode;

export interface ParagraphNode {
  type: "paragraph";
  children: InlineContent[];
}

export interface HeadingNode {
  type: "heading";
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  children: InlineContent[];
}

export interface QuoteNode {
  type: "quote";
  children: BlockNode[];
}

export interface ListNode {
  type: "list";
  ordered: boolean;
  start?: number;
  spread: boolean;
  children: ListItemNode[];
}

export interface ListItemNode {
  type: "listItem";
  checked?: boolean | null;
  spread: boolean;
  children: BlockNode[];
}

export interface CodeNode {
  type: "code";
  lang?: string;
  meta?: string;
  value: string;
}

export interface TableNode {
  type: "table";
  align: AlignType[];
  children: TableRowNode[];
}

export interface TableRowNode {
  type: "tableRow";
  children: TableCellNode[];
}

export interface TableCellNode {
  type: "tableCell";
  children: InlineContent[];
}

export interface ImageNode {
  type: "image";
  url: string;
  alt?: string;
  title?: string;
}

export interface ThematicBreakNode {
  type: "thematicBreak";
}

export interface FootnoteDefinitionNode {
  type: "footnoteDefinition";
  identifier: string;
  label?: string;
  children: BlockNode[];
}

export interface DefinitionNode {
  type: "definition";
  identifier: string;
  label?: string;
  url: string;
  title?: string;
}

export interface CalloutProps {
  type: "info" | "note" | "tip" | "warning" | "danger" | "success";
  title?: string;
  icon?: string;
}
export interface CalloutNode {
  type: "callout";
  version: 1;
  props: CalloutProps;
  children: BlockNode[];
}

export interface StickyProps {
  tone: "default" | "yellow" | "pink" | "blue" | "green";
  title?: string;
}
export interface StickyNode {
  type: "sticky";
  version: 1;
  props: StickyProps;
  children: BlockNode[];
}

export interface ToggleProps {
  title: string;
  open: boolean;
}
export interface ToggleNode {
  type: "toggle";
  version: 1;
  props: ToggleProps;
  children: BlockNode[];
}

export interface TabsNode {
  type: "tabs";
  version: 1;
  children: TabNode[];
}
export interface TabNode {
  type: "tab";
  version: 1;
  props: { title: string };
  children: BlockNode[];
}

export interface ColumnsProps {
  count: 2 | 3 | 4;
  gap?: "sm" | "md" | "lg";
}
export interface ColumnsNode {
  type: "columns";
  version: 1;
  props: ColumnsProps;
  children: ColumnNode[];
}
export interface ColumnNode {
  type: "column";
  version: 1;
  children: BlockNode[];
}

export interface RuntimeProps {
  height: number;
  network: string[];
  autoplay: boolean;
}
export interface RuntimeNode {
  type: "runtime";
  version: 1;
  runtime: "p5" | "canvas";
  props: RuntimeProps;
  source: string;
}

export interface UnknownDirectiveNode {
  type: "unknown-directive";
  directiveType: "container" | "leaf" | "text";
  name: string;
  attributes: Record<string, string>;
  children: BlockNode[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  attribute?: string;
}

export interface InvalidBlockNode {
  type: "invalid-block";
  originalType: string;
  attributes: Record<string, string>;
  errors: ValidationIssue[];
  /** Preserved raw markdown/source for round-trip (e.g. raw HTML value). */
  source?: string;
  children: BlockNode[];
}
```

- [ ] **Step 2: Write the failing test `src/ast/normalize.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { semanticNormalize } from "./normalize.js";
import type { NotebookDocument } from "./nodes.js";

describe("semanticNormalize", () => {
  it("drops the default toggle open value and orders callout props deterministically", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        {
          type: "callout",
          version: 1,
          props: { title: "T", type: "warning" },
          children: [],
        },
      ],
    };
    const normalized = semanticNormalize(doc);
    expect(JSON.stringify(normalized)).toContain('"type":"warning"');
  });

  it("is idempotent", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [{ type: "thematicBreak" }],
    };
    expect(semanticNormalize(semanticNormalize(doc))).toEqual(semanticNormalize(doc));
  });
});
```

- [ ] **Step 3: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- normalize`
Expected: FAIL (`semanticNormalize` not found).

- [ ] **Step 4: Write `src/ast/normalize.ts`**

`semanticNormalize` returns a deep copy with formatting-only noise removed so the round-trip invariant compares meaning. Rules: recurse the tree; for objects, sort keys; drop `undefined` fields. This canonical JSON form makes `toEqual` semantic.

```ts
import type { NotebookDocument } from "./nodes.js";

/**
 * Produce a canonical comparison form of a document. Deep-clones, drops
 * undefined-valued properties, and sorts object keys so structurally-equal
 * documents compare equal regardless of property insertion order.
 * Formatting is not semantic (MARKDOWN_SPEC.md §35/§36).
 */
export function semanticNormalize(document: NotebookDocument): NotebookDocument {
  return canonical(document) as NotebookDocument;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) continue;
      result[key] = canonical(child);
    }
    return result;
  }
  return value;
}
```

- [ ] **Step 5: Write `src/ast/index.ts`**

```ts
export * from "./nodes.js";
export { semanticNormalize } from "./normalize.js";
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test -- normalize`
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add packages/document-engine/src/ast
git commit -m "feat: document-engine semantic AST types and normalize"
```

---

### Task 3: Registry contract + diagnostics

**Files:**

- Create: `packages/document-engine/src/registry/types.ts`
- Create: `packages/document-engine/src/validation/diagnostics.ts`
- Create: `packages/document-engine/src/validation/index.ts`
- Create: `packages/document-engine/src/validation/diagnostics.test.ts`

**Interfaces:**

- Consumes: AST nodes (Task 2), `mdast-util-directive` directive node types, `zod`.
- Produces: `BlockCapability`, `DirectiveMdastNode`, `TransformContext`, `SerializeContext`, `BlockDefinition`; `DocumentDiagnostic`, `DiagnosticSeverity`, `DIAGNOSTIC_CODES`, and factory `diagnostic(code, severity, message, extra?)`.

- [ ] **Step 1: Write `src/registry/types.ts`**

```ts
import type { ZodType } from "zod";
import type { ContainerDirective, LeafDirective, TextDirective } from "mdast-util-directive";
import type { RootContent } from "mdast";
import type { BlockNode } from "../ast/nodes.js";
import type { DocumentDiagnostic } from "../validation/diagnostics.js";

export type BlockCapability = "static" | "interactive-ui" | "sandbox-runtime" | "network-request";

export type DirectiveMdastNode = ContainerDirective | LeafDirective | TextDirective;

export interface TransformContext {
  /** Transform a list of MDAST block children into semantic block nodes. */
  transformChildren(children: RootContent[]): BlockNode[];
  addDiagnostic(diagnostic: DocumentDiagnostic): void;
}

export interface SerializeContext {
  /** Serialize semantic block children back into MDAST content. */
  serializeChildren(children: BlockNode[]): RootContent[];
}

export interface BlockDefinition<TNode extends BlockNode = BlockNode> {
  name: string;
  version: number;
  kind: "container" | "leaf" | "text";
  schema: ZodType;
  capabilities: BlockCapability[];
  fromDirective(node: DirectiveMdastNode, context: TransformContext): TNode;
  toDirective(node: TNode, context: SerializeContext): DirectiveMdastNode;
}
```

- [ ] **Step 2: Write the failing test `src/validation/diagnostics.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { diagnostic, DIAGNOSTIC_CODES } from "./diagnostics.js";

describe("diagnostic", () => {
  it("builds a diagnostic with code, severity, and message", () => {
    const d = diagnostic(DIAGNOSTIC_CODES.ATTRIBUTE_INVALID_VALUE, "error", "bad", {
      block: "callout",
      attribute: "type",
    });
    expect(d).toEqual({
      code: "ATTRIBUTE_INVALID_VALUE",
      severity: "error",
      message: "bad",
      block: "callout",
      attribute: "type",
    });
  });
});
```

- [ ] **Step 3: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- diagnostics`
Expected: FAIL.

- [ ] **Step 4: Write `src/validation/diagnostics.ts`**

The §41 code list is non-exhaustive ("Examples"); version/HTML codes are added here.

```ts
export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DocumentDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  range?: { from: number; to: number };
  block?: string;
  attribute?: string;
}

export const DIAGNOSTIC_CODES = {
  DIRECTIVE_UNKNOWN: "DIRECTIVE_UNKNOWN",
  DIRECTIVE_INVALID_NAME: "DIRECTIVE_INVALID_NAME",
  ATTRIBUTE_UNKNOWN: "ATTRIBUTE_UNKNOWN",
  ATTRIBUTE_INVALID_VALUE: "ATTRIBUTE_INVALID_VALUE",
  ATTRIBUTE_REQUIRED: "ATTRIBUTE_REQUIRED",
  INVALID_PARENT: "INVALID_PARENT",
  INVALID_CHILD: "INVALID_CHILD",
  UNSUPPORTED_SPEC_VERSION: "UNSUPPORTED_SPEC_VERSION",
  SPEC_VERSION_MISSING: "SPEC_VERSION_MISSING",
  SPEC_VERSION_INVALID: "SPEC_VERSION_INVALID",
  SPEC_VERSION_MISMATCH: "SPEC_VERSION_MISMATCH",
  RAW_HTML_DISABLED: "RAW_HTML_DISABLED",
} as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export function diagnostic(
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  extra?: Pick<DocumentDiagnostic, "range" | "block" | "attribute">,
): DocumentDiagnostic {
  const result: DocumentDiagnostic = { code, severity, message };
  if (extra?.range) result.range = extra.range;
  if (extra?.block) result.block = extra.block;
  if (extra?.attribute) result.attribute = extra.attribute;
  return result;
}
```

- [ ] **Step 5: Write `src/validation/index.ts`**

```ts
export * from "./diagnostics.js";
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test -- diagnostics`
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add packages/document-engine/src/registry/types.ts packages/document-engine/src/validation
git commit -m "feat: document-engine registry contract and diagnostics"
```

---

### Task 4: Parser — MDAST pipeline + frontmatter (W2, parallel)

**Files:**

- Create: `packages/document-engine/src/parser/mdast.ts`
- Create: `packages/document-engine/src/parser/frontmatter.ts`
- Create: `packages/document-engine/src/parser/mdast.test.ts`
- Create: `packages/document-engine/src/parser/frontmatter.test.ts`

**Interfaces:**

- Consumes: `unified`, `remark-parse`, `remark-gfm`, `remark-directive`, `remark-frontmatter`, `remark-stringify`, `yaml`; diagnostics (Task 3).
- Produces:
  - `createProcessor(): Processor` — a frozen-safe unified processor configured for parse and stringify.
  - `parseToMdast(markdown: string): Root` — returns the MDAST root (never throws on valid UTF-8).
  - `extractSpecVersion(tree: Root): { version: number | null; diagnostics: DocumentDiagnostic[] }` — reads/validates the `glyphquire-spec` frontmatter field.

- [ ] **Step 1: Write the failing test `src/parser/mdast.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseToMdast } from "./mdast.js";

describe("parseToMdast", () => {
  it("parses a container directive into a containerDirective node", () => {
    const tree = parseToMdast(':::callout{type="info"}\nHi\n:::\n');
    const node = tree.children.find((c) => c.type === "containerDirective");
    expect(node).toBeDefined();
    // @ts-expect-error narrowing for test
    expect(node.name).toBe("callout");
  });

  it("parses GFM tables", () => {
    const tree = parseToMdast("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(tree.children.some((c) => c.type === "table")).toBe(true);
  });

  it("does not throw on arbitrary input", () => {
    expect(() => parseToMdast("�￿:::{}}}not valid")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- mdast`
Expected: FAIL.

- [ ] **Step 3: Write `src/parser/mdast.ts`**

```ts
import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import type { Root } from "mdast";

/**
 * A unified processor configured for both parse (markdown -> MDAST) and
 * stringify (MDAST -> markdown) with GFM, generic directives, and YAML
 * frontmatter. The same plugin set MUST back both directions so directive
 * fences round-trip.
 */
export function createProcessor(): Processor<Root, undefined, undefined, Root, string> {
  return unified()
    .use(remarkParse)
    .use(remarkStringify, {
      bullet: "-",
      fences: true,
      listItemIndent: "one",
      rule: "-",
    })
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkDirective) as unknown as Processor<Root, undefined, undefined, Root, string>;
}

/** Parse markdown into MDAST. Never throws on arbitrary UTF-8. */
export function parseToMdast(markdown: string): Root {
  return createProcessor().parse(markdown);
}
```

- [ ] **Step 4: Run mdast test**

Run: `pnpm --filter @glyphquire/document-engine test -- mdast`
Expected: PASS.

- [ ] **Step 5: Write the failing test `src/parser/frontmatter.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseToMdast } from "./mdast.js";
import { extractSpecVersion } from "./frontmatter.js";

function version(md: string) {
  return extractSpecVersion(parseToMdast(md));
}

describe("extractSpecVersion", () => {
  it("reads a valid positive integer version", () => {
    const r = version("---\nglyphquire-spec: 1\n---\n\n# Hi\n");
    expect(r.version).toBe(1);
    expect(r.diagnostics).toHaveLength(0);
  });

  it("flags a missing marker", () => {
    const r = version("# Hi\n");
    expect(r.version).toBeNull();
    expect(r.diagnostics[0]?.code).toBe("SPEC_VERSION_MISSING");
  });

  it("rejects a non-positive version", () => {
    const r = version("---\nglyphquire-spec: 0\n---\n");
    expect(r.version).toBeNull();
    expect(r.diagnostics[0]?.code).toBe("SPEC_VERSION_INVALID");
  });

  it("rejects a non-integer version", () => {
    const r = version("---\nglyphquire-spec: 1.5\n---\n");
    expect(r.version).toBeNull();
    expect(r.diagnostics[0]?.code).toBe("SPEC_VERSION_INVALID");
  });
});
```

- [ ] **Step 6: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- frontmatter`
Expected: FAIL.

- [ ] **Step 7: Write `src/parser/frontmatter.ts`**

```ts
import type { Root, Yaml } from "mdast";
import { parse as parseYaml } from "yaml";
import {
  diagnostic,
  DIAGNOSTIC_CODES,
  type DocumentDiagnostic,
} from "../validation/diagnostics.js";

const SPEC_FIELD = "glyphquire-spec";

export function extractSpecVersion(tree: Root): {
  version: number | null;
  diagnostics: DocumentDiagnostic[];
} {
  const yamlNode = tree.children.find((c): c is Yaml => c.type === "yaml");
  if (!yamlNode) {
    return {
      version: null,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_MISSING,
          "warning",
          `Missing required frontmatter field "${SPEC_FIELD}".`,
        ),
      ],
    };
  }

  let data: unknown;
  try {
    data = parseYaml(yamlNode.value);
  } catch {
    return {
      version: null,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_INVALID,
          "error",
          "Frontmatter is not valid YAML.",
        ),
      ],
    };
  }

  const raw =
    data && typeof data === "object" ? (data as Record<string, unknown>)[SPEC_FIELD] : undefined;

  if (raw === undefined) {
    return {
      version: null,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_MISSING,
          "warning",
          `Missing required frontmatter field "${SPEC_FIELD}".`,
        ),
      ],
    };
  }

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return {
      version: null,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_INVALID,
          "error",
          `"${SPEC_FIELD}" must be a positive integer, received ${JSON.stringify(raw)}.`,
        ),
      ],
    };
  }

  return { version: raw, diagnostics: [] };
}
```

- [ ] **Step 8: Run frontmatter test + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test -- parser`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/document-engine/src/parser/mdast.ts packages/document-engine/src/parser/frontmatter.ts packages/document-engine/src/parser/mdast.test.ts packages/document-engine/src/parser/frontmatter.test.ts
git commit -m "feat: document-engine MDAST pipeline and spec-version extraction"
```

---

### Task 5: Serializer — MDAST → Markdown (W2, parallel)

**Files:**

- Create: `packages/document-engine/src/serializer/to-markdown.ts`
- Create: `packages/document-engine/src/serializer/to-markdown.test.ts`

**Interfaces:**

- Consumes: `createProcessor` (Task 4, `../parser/mdast.js`).
- Produces: `mdastToMarkdown(tree: Root): string` — deterministic canonical formatting (LF, ATX headings, backtick fences, trailing newline, correct nested directive fence length via the directive serializer).

Note: this task depends on Task 4's `createProcessor`. In W2 parallel execution, if Task 4 is not yet merged, define a local minimal processor here and reconcile at integration; the controller will note this. Prefer importing `createProcessor` once Task 4 lands.

- [ ] **Step 1: Write the failing test `src/serializer/to-markdown.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseToMdast } from "../parser/mdast.js";
import { mdastToMarkdown } from "./to-markdown.js";

describe("mdastToMarkdown", () => {
  it("round-trips a nested container directive with sufficient fence length", () => {
    const input = '::::columns{count="2"}\n\n:::callout{type="info"}\nLeft\n:::\n\n::::\n';
    const out = mdastToMarkdown(parseToMdast(input));
    expect(out).toContain("::::columns");
    expect(out).toContain(":::callout");
    // outer fence longer than inner
    expect(out.indexOf("::::columns")).toBeGreaterThanOrEqual(0);
  });

  it("ends with a trailing newline", () => {
    const out = mdastToMarkdown(parseToMdast("# Hi\n"));
    expect(out.endsWith("\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- to-markdown`
Expected: FAIL.

- [ ] **Step 3: Write `src/serializer/to-markdown.ts`**

```ts
import type { Root } from "mdast";
import { createProcessor } from "../parser/mdast.js";

/**
 * Serialize an MDAST tree to canonical Notebook Markdown. Uses the shared
 * unified processor (directive-aware) so directive fences and attributes are
 * emitted by the directive serializer, never string-concatenated
 * (MARKDOWN_SPEC.md §12/§34). The directive serializer chooses a fence length
 * that safely wraps nested directives (§13).
 */
export function mdastToMarkdown(tree: Root): string {
  const processor = createProcessor();
  const out = processor.stringify(tree);
  return out.endsWith("\n") ? out : `${out}\n`;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test -- to-markdown`
Expected: pass. If the nested-fence assertion fails, verify `remark-directive` is registered on the processor (it is, via `createProcessor`).

- [ ] **Step 5: Commit**

```bash
git add packages/document-engine/src/serializer/to-markdown.ts packages/document-engine/src/serializer/to-markdown.test.ts
git commit -m "feat: document-engine MDAST-to-markdown serializer"
```

---

### Task 6: Registry + built-in block definitions (W2, parallel)

**Files:**

- Create: `packages/document-engine/src/registry/registry.ts`
- Create: `packages/document-engine/src/registry/blocks/callout.ts`
- Create: `packages/document-engine/src/registry/blocks/sticky.ts`
- Create: `packages/document-engine/src/registry/blocks/toggle.ts`
- Create: `packages/document-engine/src/registry/blocks/tabs.ts`
- Create: `packages/document-engine/src/registry/blocks/columns.ts`
- Create: `packages/document-engine/src/registry/blocks/runtime.ts`
- Create: `packages/document-engine/src/registry/builtins.ts`
- Create: `packages/document-engine/src/registry/index.ts`
- Create: `packages/document-engine/src/registry/registry.test.ts`
- Create: `packages/document-engine/src/registry/blocks/blocks.test.ts`

**Interfaces:**

- Consumes: AST nodes (Task 2), registry types + diagnostics (Task 3), `zod`, `mdast-util-directive` node types.
- Produces:
  - `BlockRegistry` class: `register(def)`, `get(name): BlockDefinition | undefined`, `has(name)`, `RESERVED_NAMES`.
  - `createRegistry(): BlockRegistry` (in `builtins.ts`) with all six built-ins registered.
  - Each block module exports `<name>Block: BlockDefinition<...>`.

Shared helpers used by every block (define in `registry.ts` and import):

- `readAttributes(node): Record<string, string>` — coerce directive `attributes` (which may hold `string | null | undefined`) to `Record<string, string>`, dropping null/undefined.
- `directiveTypeOf(node)` — returns `"container" | "leaf" | "text"`.

- [ ] **Step 1: Write `src/registry/registry.ts`**

```ts
import type { DirectiveMdastNode } from "./types.js";
import type { BlockDefinition } from "./types.js";

export const RESERVED_NAMES = [
  "callout",
  "sticky",
  "toggle",
  "tabs",
  "tab",
  "columns",
  "column",
  "p5",
  "canvas",
] as const;

const RESERVED = new Set<string>(RESERVED_NAMES);

export class BlockRegistry {
  private readonly definitions = new Map<string, BlockDefinition>();

  register(definition: BlockDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`Block "${definition.name}" is already registered.`);
    }
    this.definitions.set(definition.name, definition);
  }

  get(name: string): BlockDefinition | undefined {
    return this.definitions.get(name);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }
}

export function isReservedName(name: string): boolean {
  return RESERVED.has(name);
}

/** Coerce a directive node's attributes to a plain string record. */
export function readAttributes(node: DirectiveMdastNode): Record<string, string> {
  const result: Record<string, string> = {};
  const attrs = node.attributes ?? {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function directiveTypeOf(node: DirectiveMdastNode): "container" | "leaf" | "text" {
  if (node.type === "containerDirective") return "container";
  if (node.type === "leafDirective") return "leaf";
  return "text";
}
```

- [ ] **Step 2: Write `src/registry/blocks/callout.ts`** (worked template)

```ts
import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type { Paragraph } from "mdast";
import type {
  BlockDefinition,
  TransformContext,
  SerializeContext,
  DirectiveMdastNode,
} from "../types.js";
import type { CalloutNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const calloutSchema = z.object({
  type: z.enum(["info", "note", "tip", "warning", "danger", "success"]).default("info"),
  title: z.string().optional(),
  icon: z.string().optional(),
});

export const calloutBlock: BlockDefinition<CalloutNode> = {
  name: "callout",
  version: 1,
  kind: "container",
  capabilities: ["static"],
  schema: calloutSchema,
  fromDirective(node: DirectiveMdastNode, context: TransformContext): CalloutNode {
    const attrs = readAttributes(node);
    const props = calloutSchema.parse(attrs);
    const container = node as ContainerDirective;
    return {
      type: "callout",
      version: 1,
      props,
      children: context.transformChildren(container.children),
    };
  },
  toDirective(node: CalloutNode, context: SerializeContext): DirectiveMdastNode {
    const attributes: Record<string, string> = { type: node.props.type };
    if (node.props.title !== undefined) attributes.title = node.props.title;
    if (node.props.icon !== undefined) attributes.icon = node.props.icon;
    const directive: ContainerDirective = {
      type: "containerDirective",
      name: "callout",
      attributes,
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
    return directive;
  },
};
```

- [ ] **Step 3: Write `src/registry/blocks/sticky.ts`**

```ts
import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type {
  BlockDefinition,
  TransformContext,
  SerializeContext,
  DirectiveMdastNode,
} from "../types.js";
import type { StickyNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const stickySchema = z.object({
  tone: z.enum(["default", "yellow", "pink", "blue", "green"]).default("default"),
  title: z.string().optional(),
});

export const stickyBlock: BlockDefinition<StickyNode> = {
  name: "sticky",
  version: 1,
  kind: "container",
  capabilities: ["static"],
  schema: stickySchema,
  fromDirective(node, context): StickyNode {
    const props = stickySchema.parse(readAttributes(node));
    const container = node as ContainerDirective;
    return {
      type: "sticky",
      version: 1,
      props,
      children: context.transformChildren(container.children),
    };
  },
  toDirective(node, context): DirectiveMdastNode {
    const attributes: Record<string, string> = { tone: node.props.tone };
    if (node.props.title !== undefined) attributes.title = node.props.title;
    return {
      type: "containerDirective",
      name: "sticky",
      attributes,
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};
```

- [ ] **Step 4: Write `src/registry/blocks/toggle.ts`**

`title` required non-empty; `open` defaults false; serializer omits `open="false"`.

```ts
import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type {
  BlockDefinition,
  TransformContext,
  SerializeContext,
  DirectiveMdastNode,
} from "../types.js";
import type { ToggleNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const toggleSchema = z.object({
  title: z.string().min(1),
  open: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const toggleBlock: BlockDefinition<ToggleNode> = {
  name: "toggle",
  version: 1,
  kind: "container",
  capabilities: ["interactive-ui"],
  schema: toggleSchema,
  fromDirective(node, context): ToggleNode {
    const props = toggleSchema.parse(readAttributes(node));
    const container = node as ContainerDirective;
    return {
      type: "toggle",
      version: 1,
      props,
      children: context.transformChildren(container.children),
    };
  },
  toDirective(node, context): DirectiveMdastNode {
    const attributes: Record<string, string> = { title: node.props.title };
    if (node.props.open) attributes.open = "true"; // omit default false
    return {
      type: "containerDirective",
      name: "toggle",
      attributes,
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};
```

- [ ] **Step 5: Write `src/registry/blocks/tabs.ts`** (parent `tabs` + child `tab`)

Both defs are exported. `tab.fromDirective` builds a `TabNode`; `tabs.fromDirective` collects child `tab` nodes (non-tab children are still transformed but flagged by the validator in Task 9). `title` required.

```ts
import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type {
  BlockDefinition,
  TransformContext,
  SerializeContext,
  DirectiveMdastNode,
} from "../types.js";
import type { TabsNode, TabNode, BlockNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const tabSchema = z.object({ title: z.string().min(1) });

export const tabBlock: BlockDefinition<TabNode> = {
  name: "tab",
  version: 1,
  kind: "container",
  capabilities: ["interactive-ui"],
  schema: tabSchema,
  fromDirective(node, context): TabNode {
    const props = tabSchema.parse(readAttributes(node));
    const container = node as ContainerDirective;
    return {
      type: "tab",
      version: 1,
      props,
      children: context.transformChildren(container.children),
    };
  },
  toDirective(node, context): DirectiveMdastNode {
    return {
      type: "containerDirective",
      name: "tab",
      attributes: { title: node.props.title },
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};

export const tabsBlock: BlockDefinition<TabsNode> = {
  name: "tabs",
  version: 1,
  kind: "container",
  capabilities: ["interactive-ui"],
  schema: z.object({}),
  fromDirective(node, context): TabsNode {
    const container = node as ContainerDirective;
    const transformed: BlockNode[] = context.transformChildren(container.children);
    const children = transformed.filter((c): c is TabNode => c.type === "tab");
    return { type: "tabs", version: 1, children };
  },
  toDirective(node, context): DirectiveMdastNode {
    return {
      type: "containerDirective",
      name: "tabs",
      attributes: {},
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};
```

- [ ] **Step 6: Write `src/registry/blocks/columns.ts`** (parent `columns` + child `column`)

`count` 2–4; infer from child count when absent; `gap` optional enum.

```ts
import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type {
  BlockDefinition,
  TransformContext,
  SerializeContext,
  DirectiveMdastNode,
} from "../types.js";
import type { ColumnsNode, ColumnNode, BlockNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const columnsSchema = z.object({
  count: z
    .enum(["2", "3", "4"])
    .optional()
    .transform((v) => (v === undefined ? undefined : (Number(v) as 2 | 3 | 4))),
  gap: z.enum(["sm", "md", "lg"]).optional(),
});

export const columnBlock: BlockDefinition<ColumnNode> = {
  name: "column",
  version: 1,
  kind: "container",
  capabilities: ["static"],
  schema: z.object({}),
  fromDirective(node, context): ColumnNode {
    const container = node as ContainerDirective;
    return { type: "column", version: 1, children: context.transformChildren(container.children) };
  },
  toDirective(node, context): DirectiveMdastNode {
    return {
      type: "containerDirective",
      name: "column",
      attributes: {},
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};

export const columnsBlock: BlockDefinition<ColumnsNode> = {
  name: "columns",
  version: 1,
  kind: "container",
  capabilities: ["static"],
  schema: columnsSchema,
  fromDirective(node, context): ColumnsNode {
    const parsed = columnsSchema.parse(readAttributes(node));
    const container = node as ContainerDirective;
    const transformed: BlockNode[] = context.transformChildren(container.children);
    const children = transformed.filter((c): c is ColumnNode => c.type === "column");
    const count = (parsed.count ?? Math.min(Math.max(children.length, 2), 4)) as 2 | 3 | 4;
    const props: ColumnsNode["props"] = { count };
    if (parsed.gap !== undefined) props.gap = parsed.gap;
    return { type: "columns", version: 1, props, children };
  },
  toDirective(node, context): DirectiveMdastNode {
    const attributes: Record<string, string> = { count: String(node.props.count) };
    if (node.props.gap !== undefined) attributes.gap = node.props.gap;
    return {
      type: "containerDirective",
      name: "columns",
      attributes,
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};
```

- [ ] **Step 7: Write `src/registry/blocks/runtime.ts`** (`p5` + `canvas`)

The runtime block preserves the fenced code source. In MDAST the directive's children contain a `code` node; `fromDirective` extracts its `value`. `toDirective` emits a container directive whose single child is a `code` node. Source is never executed.

```ts
import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type { Code } from "mdast";
import type { BlockDefinition, DirectiveMdastNode } from "../types.js";
import type { RuntimeNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const runtimeSchema = z.object({
  height: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 400 : Number(v)))
    .pipe(z.number().int().positive()),
  network: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? [] : [v])),
  autoplay: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

function makeRuntimeBlock(runtime: "p5" | "canvas"): BlockDefinition<RuntimeNode> {
  return {
    name: runtime,
    version: 1,
    kind: "container",
    capabilities: ["sandbox-runtime"],
    schema: runtimeSchema,
    fromDirective(node): RuntimeNode {
      const props = runtimeSchema.parse(readAttributes(node));
      const container = node as ContainerDirective;
      const codeNode = container.children.find((c): c is Code => c.type === "code");
      return {
        type: "runtime",
        version: 1,
        runtime,
        props,
        source: codeNode?.value ?? "",
      };
    },
    toDirective(node): DirectiveMdastNode {
      const attributes: Record<string, string> = { height: String(node.props.height) };
      if (node.props.network.length > 0) attributes.network = node.props.network[0]!;
      if (node.props.autoplay) attributes.autoplay = "true";
      const code: Code = { type: "code", lang: "js", value: node.source };
      const directive: ContainerDirective = {
        type: "containerDirective",
        name: runtime,
        attributes,
        children: [code],
      };
      return directive;
    },
  };
}

export const p5Block = makeRuntimeBlock("p5");
export const canvasBlock = makeRuntimeBlock("canvas");
```

- [ ] **Step 8: Write `src/registry/builtins.ts`**

```ts
import { BlockRegistry } from "./registry.js";
import { calloutBlock } from "./blocks/callout.js";
import { stickyBlock } from "./blocks/sticky.js";
import { toggleBlock } from "./blocks/toggle.js";
import { tabsBlock, tabBlock } from "./blocks/tabs.js";
import { columnsBlock, columnBlock } from "./blocks/columns.js";
import { p5Block, canvasBlock } from "./blocks/runtime.js";

/** A registry preloaded with every v0.1 built-in block definition. */
export function createRegistry(): BlockRegistry {
  const registry = new BlockRegistry();
  for (const def of [
    calloutBlock,
    stickyBlock,
    toggleBlock,
    tabsBlock,
    tabBlock,
    columnsBlock,
    columnBlock,
    p5Block,
    canvasBlock,
  ]) {
    registry.register(def);
  }
  return registry;
}
```

- [ ] **Step 9: Write `src/registry/index.ts`**

```ts
export * from "./types.js";
export {
  BlockRegistry,
  RESERVED_NAMES,
  isReservedName,
  readAttributes,
  directiveTypeOf,
} from "./registry.js";
export { createRegistry } from "./builtins.js";
```

- [ ] **Step 10: Write `src/registry/registry.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createRegistry } from "./builtins.js";
import { RESERVED_NAMES } from "./registry.js";

describe("registry", () => {
  it("registers all reserved built-in names", () => {
    const registry = createRegistry();
    for (const name of RESERVED_NAMES) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("rejects duplicate registration", () => {
    const registry = createRegistry();
    expect(() => registry.register(registry.get("callout")!)).toThrow();
  });
});
```

- [ ] **Step 11: Write `src/registry/blocks/blocks.test.ts`**

Each block is tested by hand-building a directive node and asserting the semantic node, then reversing. Uses a stub context.

```ts
import { describe, it, expect } from "vitest";
import type { ContainerDirective } from "mdast-util-directive";
import type { RootContent } from "mdast";
import { calloutBlock } from "./callout.js";
import { toggleBlock } from "./toggle.js";
import { p5Block } from "./runtime.js";
import type { BlockNode } from "../../ast/nodes.js";
import type { TransformContext, SerializeContext } from "../types.js";

const tx: TransformContext = { transformChildren: () => [], addDiagnostic: () => {} };
const sx: SerializeContext = { serializeChildren: (): RootContent[] => [] };

function container(
  name: string,
  attributes: Record<string, string>,
  children: RootContent[] = [],
): ContainerDirective {
  return {
    type: "containerDirective",
    name,
    attributes,
    children: children as ContainerDirective["children"],
  };
}

describe("callout block", () => {
  it("parses type and title, defaults type to info", () => {
    const node = calloutBlock.fromDirective(container("callout", {}), tx);
    expect(node.props.type).toBe("info");
  });
  it("throws (schema-invalid) on bad enum", () => {
    expect(() =>
      calloutBlock.fromDirective(container("callout", { type: "rainbow" }), tx),
    ).toThrow();
  });
  it("serializes type attribute", () => {
    const dir = calloutBlock.toDirective(
      { type: "callout", version: 1, props: { type: "danger" }, children: [] },
      sx,
    ) as ContainerDirective;
    expect(dir.attributes?.type).toBe("danger");
  });
});

describe("toggle block", () => {
  it("requires a non-empty title", () => {
    expect(() => toggleBlock.fromDirective(container("toggle", {}), tx)).toThrow();
  });
  it("omits default open on serialize", () => {
    const dir = toggleBlock.toDirective(
      { type: "toggle", version: 1, props: { title: "T", open: false }, children: [] },
      sx,
    ) as ContainerDirective;
    expect(dir.attributes?.open).toBeUndefined();
  });
});

describe("runtime block", () => {
  it("preserves source without executing", () => {
    const code: RootContent = { type: "code", lang: "js", value: "circle(1,2,3)" };
    const node = p5Block.fromDirective(container("p5", { height: "400" }, [code]), tx);
    expect(node.source).toBe("circle(1,2,3)");
    expect(node.runtime).toBe("p5");
  });
});
```

- [ ] **Step 12: Run tests + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test -- registry blocks`
Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add packages/document-engine/src/registry
git commit -m "feat: document-engine block registry and built-in definitions"
```

---

### Task 7: Migration framework (W2, parallel)

**Files:**

- Create: `packages/document-engine/src/migration/types.ts`
- Create: `packages/document-engine/src/migration/migrate.ts`
- Create: `packages/document-engine/src/migration/index.ts`
- Create: `packages/document-engine/src/migration/migrate.test.ts`

**Interfaces:**

- Consumes: diagnostics (Task 3).
- Produces: `CURRENT_SPEC_VERSION = 1`; `MigrationResult`; `migrateDocument(markdown, from, to): MigrationResult`; `Migration` interface + empty registry for future steps.

- [ ] **Step 1: Write the failing test `src/migration/migrate.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { migrateDocument, CURRENT_SPEC_VERSION } from "./migrate.js";

describe("migrateDocument", () => {
  it("v1 -> v1 is identity", () => {
    const md = "---\nglyphquire-spec: 1\n---\n\n# Hi\n";
    const r = migrateDocument(md, 1, 1);
    expect(r.ok).toBe(true);
    expect(r.markdown).toBe(md);
    expect(r.diagnostics).toHaveLength(0);
  });

  it("rejects unsupported future target version and preserves source", () => {
    const md = "# Hi\n";
    const r = migrateDocument(md, 1, 2);
    expect(r.ok).toBe(false);
    expect(r.markdown).toBe(md);
    expect(r.diagnostics[0]?.code).toBe("UNSUPPORTED_SPEC_VERSION");
  });

  it("rejects a non-positive from version", () => {
    const r = migrateDocument("x", 0, 1);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.code).toBe("SPEC_VERSION_INVALID");
  });

  it("CURRENT_SPEC_VERSION is 1", () => {
    expect(CURRENT_SPEC_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- migrate`
Expected: FAIL.

- [ ] **Step 3: Write `src/migration/types.ts`**

```ts
import type { DocumentDiagnostic } from "../validation/diagnostics.js";

export interface MigrationResult {
  markdown: string;
  ok: boolean;
  fromVersion: number;
  toVersion: number;
  diagnostics: DocumentDiagnostic[];
  snapshot?: string;
}

export interface Migration {
  from: number;
  to: number;
  apply(markdown: string): {
    markdown: string;
    diagnostics: DocumentDiagnostic[];
    destructive: boolean;
  };
}
```

- [ ] **Step 4: Write `src/migration/migrate.ts`**

```ts
import { diagnostic, DIAGNOSTIC_CODES } from "../validation/diagnostics.js";
import type { Migration, MigrationResult } from "./types.js";

export const CURRENT_SPEC_VERSION = 1;

/** Future version-to-version steps register here. v0.1 ships none (identity only). */
const MIGRATIONS: Migration[] = [];

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

export function migrateDocument(markdown: string, from: number, to: number): MigrationResult {
  const base: Omit<MigrationResult, "ok" | "diagnostics"> = {
    markdown,
    fromVersion: from,
    toVersion: to,
  };

  if (!isPositiveInteger(from) || !isPositiveInteger(to)) {
    return {
      ...base,
      ok: false,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_INVALID,
          "error",
          "Migration versions must be positive integers.",
        ),
      ],
    };
  }

  if (to > CURRENT_SPEC_VERSION || from > CURRENT_SPEC_VERSION) {
    return {
      ...base,
      ok: false,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.UNSUPPORTED_SPEC_VERSION,
          "error",
          `Spec version ${Math.max(from, to)} is not supported (current is ${CURRENT_SPEC_VERSION}).`,
        ),
      ],
    };
  }

  if (from === to) {
    return { ...base, ok: true, diagnostics: [] };
  }

  // Build a forward chain. v0.1 has no registered steps beyond identity.
  const diagnostics = [] as MigrationResult["diagnostics"];
  let current = markdown;
  let snapshot: string | undefined;
  for (let v = from; v < to; v++) {
    const step = MIGRATIONS.find((m) => m.from === v && m.to === v + 1);
    if (!step) {
      return {
        ...base,
        ok: false,
        diagnostics: [
          diagnostic(
            DIAGNOSTIC_CODES.UNSUPPORTED_SPEC_VERSION,
            "error",
            `No migration path from ${v} to ${v + 1}.`,
          ),
        ],
      };
    }
    const applied = step.apply(current);
    if (applied.destructive && snapshot === undefined) snapshot = markdown;
    diagnostics.push(...applied.diagnostics);
    current = applied.markdown;
  }

  const result: MigrationResult = { ...base, markdown: current, ok: true, diagnostics };
  if (snapshot !== undefined) result.snapshot = snapshot;
  return result;
}
```

- [ ] **Step 5: Write `src/migration/index.ts`**

```ts
export * from "./types.js";
export { migrateDocument, CURRENT_SPEC_VERSION } from "./migrate.js";
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test -- migrate`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/document-engine/src/migration
git commit -m "feat: document-engine migration framework with v1 identity"
```

---

### Task 8: Text extraction (W2, parallel)

**Files:**

- Create: `packages/document-engine/src/text/extract.ts`
- Create: `packages/document-engine/src/text/index.ts`
- Create: `packages/document-engine/src/text/extract.test.ts`

**Interfaces:**

- Consumes: AST nodes (Task 2), `mdast-util-to-string`.
- Produces: `extractText(document: NotebookDocument): string` — searchable text per §43 (heading/paragraph/quote/list/callout/sticky/toggle/tab/image-alt titles+content), excluding directive names, runtime source, asset IDs.

- [ ] **Step 1: Write the failing test `src/text/extract.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { extractText } from "./extract.js";
import type { NotebookDocument } from "../ast/nodes.js";

describe("extractText", () => {
  it("collects heading, callout title, and paragraph text; excludes runtime source", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        { type: "heading", depth: 1, children: [{ type: "text", value: "GPU" }] },
        {
          type: "callout",
          version: 1,
          props: { type: "warning", title: "Limit" },
          children: [{ type: "paragraph", children: [{ type: "text", value: "shared memory" }] }],
        },
        {
          type: "runtime",
          version: 1,
          runtime: "p5",
          props: { height: 400, network: [], autoplay: false },
          source: "circle(1,2,3)",
        },
      ],
    };
    const text = extractText(doc);
    expect(text).toContain("GPU");
    expect(text).toContain("Limit");
    expect(text).toContain("shared memory");
    expect(text).not.toContain("circle(1,2,3)");
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- extract`
Expected: FAIL.

- [ ] **Step 3: Write `src/text/extract.ts`**

```ts
import { toString as mdastToString } from "mdast-util-to-string";
import type { NotebookDocument, BlockNode, InlineContent } from "../ast/nodes.js";

/** Collect searchable text from a document (MARKDOWN_SPEC.md §43). */
export function extractText(document: NotebookDocument): string {
  const parts: string[] = [];
  collectBlocks(document.children, parts);
  return parts.filter((p) => p.length > 0).join("\n");
}

function collectInline(children: InlineContent[], parts: string[]): void {
  // Wrap in a paragraph (whose children are exactly PhrasingContent[]) so the
  // call is type-correct under strict mode.
  parts.push(mdastToString({ type: "paragraph", children }));
}

function collectBlocks(nodes: BlockNode[], parts: string[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
      case "heading":
        collectInline(node.children, parts);
        break;
      case "quote":
      case "column":
      case "footnoteDefinition":
        collectBlocks(node.children, parts);
        break;
      case "list":
        for (const item of node.children) collectBlocks(item.children, parts);
        break;
      case "listItem":
        collectBlocks(node.children, parts);
        break;
      case "table":
        for (const row of node.children)
          for (const cell of row.children) collectInline(cell.children, parts);
        break;
      case "image":
        if (node.alt) parts.push(node.alt);
        break;
      case "callout":
      case "sticky":
        if (node.props.title) parts.push(node.props.title);
        collectBlocks(node.children, parts);
        break;
      case "toggle":
        parts.push(node.props.title);
        collectBlocks(node.children, parts);
        break;
      case "tabs":
        collectBlocks(node.children, parts);
        break;
      case "tab":
        parts.push(node.props.title);
        collectBlocks(node.children, parts);
        break;
      case "columns":
        collectBlocks(node.children, parts);
        break;
      case "unknown-directive":
      case "invalid-block":
        collectBlocks(node.children, parts);
        break;
      // code, thematicBreak, definition, runtime: excluded from search text
      default:
        break;
    }
  }
}
```

- [ ] **Step 4: Write `src/text/index.ts`**

```ts
export { extractText } from "./extract.js";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test -- extract`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/document-engine/src/text
git commit -m "feat: document-engine search-text extraction"
```

---

### Task 9: MDAST → Semantic AST transform + validation + parse (W3)

**Files:**

- Create: `packages/document-engine/src/parser/transform.ts`
- Create: `packages/document-engine/src/validation/validate.ts`
- Create: `packages/document-engine/src/parser/index.ts`
- Create: `packages/document-engine/src/parser/transform.test.ts`
- Create: `packages/document-engine/src/validation/validate.test.ts`
- Modify: `packages/document-engine/src/validation/index.ts` (export `validateDocument`)

**Interfaces:**

- Consumes: `parseToMdast`, `extractSpecVersion` (Task 4); `BlockRegistry`, `createRegistry`, `readAttributes`, `directiveTypeOf` (Task 6); AST nodes (Task 2); diagnostics (Task 3); `mdast-util-directive` node types; migration `CURRENT_SPEC_VERSION` (Task 7).
- Produces:
  - `transformRoot(tree, registry, addDiagnostic): BlockNode[]`
  - `validateDocument(document): ValidationResult` (`{ valid, diagnostics }`)
  - `parse(markdown, registry?): ParseResult` and `importLegacy(markdown, assumedVersion, registry?): ParseResult`, where `ParseResult = { document, diagnostics, specVersion }`.

Transform rules (MARKDOWN_SPEC.md §14/§15/§17/§27/§42):

- `paragraph` → ParagraphNode; **exception**: a paragraph whose only child is an `image` → ImageNode (§27, §54).
- `heading`→HeadingNode; `blockquote`→QuoteNode; `list`/`listItem`→ListNode/ListItemNode; `code`→CodeNode; `table`→TableNode (map rows/cells); `thematicBreak`→ThematicBreakNode; `footnoteDefinition`→FootnoteDefinitionNode; `definition`→DefinitionNode.
- `html` (raw block HTML, disabled in v0.1 §6) → `InvalidBlockNode` with `code RAW_HTML_DISABLED`, `source` = html value, no children; adds a diagnostic. Never discarded.
- `containerDirective`/`leafDirective`/`textDirective`: if `registry.has(name)` → `def.fromDirective`; on `def.schema` failure (thrown ZodError) → `InvalidBlockNode` preserving attributes + issues (§15.2). If not registered → `UnknownDirectiveNode` (§14) + `DIRECTIVE_UNKNOWN` diagnostic. Invalid directive name → also `DIRECTIVE_INVALID_NAME`.
- `yaml` node is consumed by frontmatter extraction, never emitted as a block.

- [ ] **Step 1: Write the failing test `src/parser/transform.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parse } from "./index.js";

describe("parse", () => {
  it("transforms a callout directive to a semantic callout node", () => {
    const r = parse(
      '---\nglyphquire-spec: 1\n---\n\n:::callout{type="warning" title="T"}\nHi\n:::\n',
    );
    const callout = r.document.children.find((c) => c.type === "callout");
    expect(callout).toBeDefined();
    // @ts-expect-error test narrowing
    expect(callout.props.type).toBe("warning");
    expect(r.specVersion).toBe(1);
  });

  it("lifts a lone image paragraph to an image node", () => {
    const r = parse("---\nglyphquire-spec: 1\n---\n\n![Arch](asset://01ABC)\n");
    expect(r.document.children.some((c) => c.type === "image")).toBe(true);
  });

  it("preserves an unknown directive without discarding it", () => {
    const r = parse('---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nHi\n:::\n');
    const unknown = r.document.children.find((c) => c.type === "unknown-directive");
    expect(unknown).toBeDefined();
    // @ts-expect-error test narrowing
    expect(unknown.name).toBe("future");
    expect(r.diagnostics.some((d) => d.code === "DIRECTIVE_UNKNOWN")).toBe(true);
  });

  it("produces an invalid-block for a schema-invalid callout", () => {
    const r = parse('---\nglyphquire-spec: 1\n---\n\n:::callout{type="banana"}\nHi\n:::\n');
    expect(r.document.children.some((c) => c.type === "invalid-block")).toBe(true);
  });

  it("never throws on arbitrary input", () => {
    expect(() => parse("� not ::: valid {{{")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- transform`
Expected: FAIL.

- [ ] **Step 3: Write `src/parser/transform.ts`**

Complete the mapping for every MDAST block type listed above. Uses the registry via a `TransformContext`.

```ts
import type {
  Root,
  RootContent,
  Paragraph,
  Heading,
  Blockquote,
  List,
  ListItem,
  Code,
  Table,
  Image,
  FootnoteDefinition,
  Definition,
  Html,
  PhrasingContent,
} from "mdast";
import type { ContainerDirective, LeafDirective, TextDirective } from "mdast-util-directive";
import { ZodError } from "zod";
import type { BlockRegistry, TransformContext, DirectiveMdastNode } from "../registry/types.js";
import { readAttributes, directiveTypeOf } from "../registry/registry.js";
import {
  diagnostic,
  DIAGNOSTIC_CODES,
  type DocumentDiagnostic,
} from "../validation/diagnostics.js";
import type {
  BlockNode,
  ImageNode,
  InvalidBlockNode,
  UnknownDirectiveNode,
  TableNode,
  TableRowNode,
  TableCellNode,
} from "../ast/nodes.js";

const DIRECTIVE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function transformRoot(
  tree: Root,
  registry: BlockRegistry,
  addDiagnostic: (d: DocumentDiagnostic) => void,
): BlockNode[] {
  const context: TransformContext = {
    transformChildren: (children) => transformNodes(children, registry, addDiagnostic),
    addDiagnostic,
  };
  return transformNodes(tree.children, registry, addDiagnostic, context);
}

function transformNodes(
  nodes: RootContent[],
  registry: BlockRegistry,
  addDiagnostic: (d: DocumentDiagnostic) => void,
  sharedContext?: TransformContext,
): BlockNode[] {
  const context: TransformContext = sharedContext ?? {
    transformChildren: (children) => transformNodes(children, registry, addDiagnostic),
    addDiagnostic,
  };
  const result: BlockNode[] = [];
  for (const node of nodes) {
    const mapped = transformNode(node, registry, context, addDiagnostic);
    if (mapped) result.push(mapped);
  }
  return result;
}

function transformNode(
  node: RootContent,
  registry: BlockRegistry,
  context: TransformContext,
  addDiagnostic: (d: DocumentDiagnostic) => void,
): BlockNode | null {
  switch (node.type) {
    case "yaml":
      return null; // consumed by frontmatter extraction
    case "paragraph":
      return transformParagraph(node);
    case "heading":
      return {
        type: "heading",
        depth: (node as Heading).depth,
        children: node.children as PhrasingContent[],
      };
    case "blockquote":
      return { type: "quote", children: context.transformChildren((node as Blockquote).children) };
    case "list":
      return transformList(node as List, context);
    case "code": {
      const code = node as Code;
      const out: BlockNode = { type: "code", value: code.value };
      if (code.lang) (out as { lang?: string }).lang = code.lang;
      if (code.meta) (out as { meta?: string }).meta = code.meta;
      return out;
    }
    case "table":
      return transformTable(node as Table);
    case "thematicBreak":
      return { type: "thematicBreak" };
    case "footnoteDefinition": {
      const fn = node as FootnoteDefinition;
      const out = {
        type: "footnoteDefinition",
        identifier: fn.identifier,
        children: context.transformChildren(fn.children),
      } as BlockNode;
      if (fn.label) (out as { label?: string }).label = fn.label;
      return out;
    }
    case "definition": {
      const def = node as Definition;
      const out = { type: "definition", identifier: def.identifier, url: def.url } as BlockNode;
      if (def.label) (out as { label?: string }).label = def.label;
      if (def.title) (out as { title?: string }).title = def.title;
      return out;
    }
    case "html":
      return transformHtml(node as Html, addDiagnostic);
    case "containerDirective":
    case "leafDirective":
    case "textDirective":
      return transformDirective(node as DirectiveMdastNode, registry, context, addDiagnostic);
    default:
      return null;
  }
}

function transformParagraph(node: Paragraph): BlockNode {
  // Lone image paragraph -> ImageNode (§27/§54)
  if (node.children.length === 1 && node.children[0]?.type === "image") {
    const img = node.children[0] as Image;
    const out: ImageNode = { type: "image", url: img.url };
    if (img.alt) out.alt = img.alt;
    if (img.title) out.title = img.title;
    return out;
  }
  return { type: "paragraph", children: node.children as PhrasingContent[] };
}

function transformList(node: List, context: TransformContext): BlockNode {
  const children = node.children.map((item: ListItem) => {
    const li = {
      type: "listItem" as const,
      spread: item.spread ?? false,
      children: context.transformChildren(item.children),
    };
    if (item.checked !== null && item.checked !== undefined) {
      (li as { checked?: boolean }).checked = item.checked;
    }
    return li;
  });
  const out = {
    type: "list" as const,
    ordered: node.ordered ?? false,
    spread: node.spread ?? false,
    children,
  };
  if (node.start !== null && node.start !== undefined)
    (out as { start?: number }).start = node.start;
  return out;
}

function transformTable(node: Table): TableNode {
  const align = (node.align ?? []).map((a) => a ?? null);
  const rows: TableRowNode[] = node.children.map((row) => ({
    type: "tableRow",
    children: row.children.map((cell): TableCellNode => ({
      type: "tableCell",
      children: cell.children as PhrasingContent[],
    })),
  }));
  return { type: "table", align, children: rows };
}

function transformHtml(
  node: Html,
  addDiagnostic: (d: DocumentDiagnostic) => void,
): InvalidBlockNode {
  addDiagnostic(
    diagnostic(DIAGNOSTIC_CODES.RAW_HTML_DISABLED, "warning", "Raw HTML is disabled in v0.1."),
  );
  return {
    type: "invalid-block",
    originalType: "html",
    attributes: {},
    errors: [{ code: DIAGNOSTIC_CODES.RAW_HTML_DISABLED, message: "Raw HTML is disabled." }],
    source: node.value,
    children: [],
  };
}

function transformDirective(
  node: DirectiveMdastNode,
  registry: BlockRegistry,
  context: TransformContext,
  addDiagnostic: (d: DocumentDiagnostic) => void,
): BlockNode {
  const name = node.name;
  const attributes = readAttributes(node);
  const kind = directiveTypeOf(node);

  // Transform children only in the fallback paths (unknown/invalid-name/
  // schema-invalid). The known-definition path lets `fromDirective` transform
  // its own children, so children are never transformed twice.
  const fallbackChildren = (): BlockNode[] =>
    node.type === "containerDirective"
      ? context.transformChildren((node as ContainerDirective).children)
      : [];

  if (!DIRECTIVE_NAME_RE.test(name)) {
    addDiagnostic(
      diagnostic(
        DIAGNOSTIC_CODES.DIRECTIVE_INVALID_NAME,
        "error",
        `Invalid directive name "${name}".`,
        { block: name },
      ),
    );
    return {
      type: "unknown-directive",
      directiveType: kind,
      name,
      attributes,
      children: fallbackChildren(),
    } satisfies UnknownDirectiveNode;
  }

  const def = registry.get(name);
  if (!def) {
    addDiagnostic(
      diagnostic(DIAGNOSTIC_CODES.DIRECTIVE_UNKNOWN, "warning", `Unknown directive "${name}".`, {
        block: name,
      }),
    );
    return {
      type: "unknown-directive",
      directiveType: kind,
      name,
      attributes,
      children: fallbackChildren(),
    } satisfies UnknownDirectiveNode;
  }

  try {
    return def.fromDirective(node, context);
  } catch (error) {
    const issues =
      error instanceof ZodError
        ? error.issues.map((i) => ({
            code: DIAGNOSTIC_CODES.ATTRIBUTE_INVALID_VALUE,
            message: i.message,
            attribute: i.path.join(".") || undefined,
          }))
        : [{ code: DIAGNOSTIC_CODES.ATTRIBUTE_INVALID_VALUE, message: String(error) }];
    for (const issue of issues) {
      addDiagnostic(
        diagnostic(issue.code, "error", issue.message, { block: name, attribute: issue.attribute }),
      );
    }
    const invalid: InvalidBlockNode = {
      type: "invalid-block",
      originalType: name,
      attributes,
      errors: issues,
      children: fallbackChildren(),
    };
    return invalid;
  }
}
```

- [ ] **Step 4: Write `src/validation/validate.ts`**

Structural validation over the semantic tree: `tab` only under `tabs` (≥1 tab), `column` only under `columns`, and non-`tab`/`column` children of those parents produce `INVALID_CHILD`.

```ts
import type { NotebookDocument, BlockNode } from "../ast/nodes.js";
import { diagnostic, DIAGNOSTIC_CODES, type DocumentDiagnostic } from "./diagnostics.js";

export interface ValidationResult {
  valid: boolean;
  diagnostics: DocumentDiagnostic[];
}

export function validateDocument(document: NotebookDocument): ValidationResult {
  const diagnostics: DocumentDiagnostic[] = [];
  walk(document.children, diagnostics);
  return { valid: !diagnostics.some((d) => d.severity === "error"), diagnostics };
}

function walk(nodes: BlockNode[], diagnostics: DocumentDiagnostic[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "tabs":
        if (node.children.length === 0) {
          diagnostics.push(
            diagnostic(
              DIAGNOSTIC_CODES.INVALID_CHILD,
              "error",
              "tabs must contain at least one tab.",
              { block: "tabs" },
            ),
          );
        }
        for (const child of node.children) walk(child.children, diagnostics);
        break;
      case "columns":
        for (const child of node.children) walk(child.children, diagnostics);
        break;
      case "tab":
        diagnostics.push(
          diagnostic(
            DIAGNOSTIC_CODES.INVALID_PARENT,
            "error",
            "tab must be a direct child of tabs.",
            { block: "tab" },
          ),
        );
        walk(node.children, diagnostics);
        break;
      case "column":
        diagnostics.push(
          diagnostic(
            DIAGNOSTIC_CODES.INVALID_PARENT,
            "error",
            "column must be a direct child of columns.",
            { block: "column" },
          ),
        );
        walk(node.children, diagnostics);
        break;
      case "callout":
      case "sticky":
      case "toggle":
      case "quote":
      case "unknown-directive":
      case "invalid-block":
      case "footnoteDefinition":
        walk(node.children, diagnostics);
        break;
      case "list":
        for (const item of node.children) walk(item.children, diagnostics);
        break;
      default:
        break;
    }
  }
}
```

Note: the `tab`/`column` "invalid parent" cases only trigger when those nodes appear at a level `walk` reaches directly (i.e., not via the `tabs`/`columns` branches, which recurse into `child.children` and never re-visit the `tab`/`column` node itself). This yields `INVALID_PARENT` exactly for misplaced tabs/columns.

- [ ] **Step 5: Write `src/parser/index.ts`**

```ts
import type { NotebookDocument } from "../ast/nodes.js";
import type { BlockRegistry } from "../registry/types.js";
import { createRegistry } from "../registry/builtins.js";
import { parseToMdast } from "./mdast.js";
import { extractSpecVersion } from "./frontmatter.js";
import { transformRoot } from "./transform.js";
import { validateDocument } from "../validation/validate.js";
import { CURRENT_SPEC_VERSION } from "../migration/migrate.js";
import {
  diagnostic,
  DIAGNOSTIC_CODES,
  type DocumentDiagnostic,
} from "../validation/diagnostics.js";

export interface ParseResult {
  document: NotebookDocument;
  diagnostics: DocumentDiagnostic[];
  specVersion: number | null;
}

export function parse(markdown: string, registry: BlockRegistry = createRegistry()): ParseResult {
  const diagnostics: DocumentDiagnostic[] = [];
  const add = (d: DocumentDiagnostic) => diagnostics.push(d);

  const tree = parseToMdast(markdown);
  const versionInfo = extractSpecVersion(tree);
  diagnostics.push(...versionInfo.diagnostics);

  if (versionInfo.version !== null && versionInfo.version > CURRENT_SPEC_VERSION) {
    add(
      diagnostic(
        DIAGNOSTIC_CODES.UNSUPPORTED_SPEC_VERSION,
        "error",
        `Spec version ${versionInfo.version} is newer than supported (${CURRENT_SPEC_VERSION}).`,
      ),
    );
  }

  const children = transformRoot(tree, registry, add);
  const document: NotebookDocument = { type: "document", specVersion: 1, children };
  diagnostics.push(...validateDocument(document).diagnostics);

  return { document, diagnostics, specVersion: versionInfo.version };
}

/** Legacy import: caller asserts a version; the original input is preserved in diagnostics context. */
export function importLegacy(
  markdown: string,
  assumedVersion: number,
  registry: BlockRegistry = createRegistry(),
): ParseResult {
  const result = parse(markdown, registry);
  return { ...result, specVersion: result.specVersion ?? assumedVersion };
}
```

- [ ] **Step 6: Write `src/validation/validate.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { validateDocument } from "./validate.js";
import type { NotebookDocument } from "../ast/nodes.js";

describe("validateDocument", () => {
  it("flags a tab outside tabs as invalid parent", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [{ type: "tab", version: 1, props: { title: "X" }, children: [] }],
    };
    const r = validateDocument(doc);
    expect(r.valid).toBe(false);
    expect(r.diagnostics[0]?.code).toBe("INVALID_PARENT");
  });

  it("accepts a well-formed tabs block", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        {
          type: "tabs",
          version: 1,
          children: [{ type: "tab", version: 1, props: { title: "A" }, children: [] }],
        },
      ],
    };
    expect(validateDocument(doc).valid).toBe(true);
  });
});
```

- [ ] **Step 7: Update `src/validation/index.ts`**

```ts
export * from "./diagnostics.js";
export { validateDocument, type ValidationResult } from "./validate.js";
```

- [ ] **Step 8: Run tests + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test -- transform validate`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/document-engine/src/parser packages/document-engine/src/validation
git commit -m "feat: document-engine MDAST transform, validation, and parse API"
```

---

### Task 10: Semantic AST → MDAST + serialize (W3)

**Files:**

- Create: `packages/document-engine/src/serializer/to-mdast.ts`
- Create: `packages/document-engine/src/serializer/index.ts`
- Create: `packages/document-engine/src/serializer/to-mdast.test.ts`

**Interfaces:**

- Consumes: AST nodes (Task 2); `BlockRegistry`/`createRegistry` (Task 6); `mdastToMarkdown` (Task 5); `mdast-util-directive` types.
- Produces: `documentToMdast(document, registry): Root`; `serialize(document, registry?): string`. Emits `glyphquire-spec` frontmatter, preserves unknown/invalid directives and `asset://` URIs.

Reverse mapping mirrors Task 9. Directive blocks call `def.toDirective`. Standard blocks reverse-map to MDAST. Frontmatter `yaml` node prepended with `glyphquire-spec: 1`.

- [ ] **Step 1: Write the failing test `src/serializer/to-mdast.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parse } from "../parser/index.js";
import { serialize } from "./index.js";

function roundTrip(md: string): string {
  return serialize(parse(md).document);
}

describe("serialize", () => {
  it("re-emits a callout directive", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n:::callout{type="warning"}\nHi\n:::\n');
    expect(out).toContain(":::callout");
    expect(out).toContain('type="warning"');
  });

  it("preserves an unknown directive", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nHi\n:::\n');
    expect(out).toContain(":::future");
    expect(out).toContain('x="1"');
  });

  it("preserves asset:// image URIs", () => {
    const out = roundTrip("---\nglyphquire-spec: 1\n---\n\n![Arch](asset://01ABC)\n");
    expect(out).toContain("asset://01ABC");
  });

  it("emits the glyphquire-spec frontmatter", () => {
    const out = roundTrip("---\nglyphquire-spec: 1\n---\n\n# Hi\n");
    expect(out).toContain("glyphquire-spec: 1");
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- to-mdast`
Expected: FAIL.

- [ ] **Step 3: Write `src/serializer/to-mdast.ts`**

Provide the complete reverse mapping for each `BlockNode` variant. Directive blocks (callout/sticky/toggle/tabs/tab/columns/column/runtime) use the registry's `toDirective`; unknown/invalid rebuild a directive from preserved data; standard blocks rebuild MDAST.

```ts
import type { Root, RootContent, Yaml, Image, PhrasingContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import type { BlockRegistry, SerializeContext } from "../registry/types.js";
import type { BlockNode, NotebookDocument } from "../ast/nodes.js";

export function documentToMdast(document: NotebookDocument, registry: BlockRegistry): Root {
  const context: SerializeContext = {
    serializeChildren: (children) => serializeBlocks(children, registry),
  };
  const frontmatter: Yaml = { type: "yaml", value: `glyphquire-spec: ${document.specVersion}` };
  return {
    type: "root",
    children: [frontmatter, ...serializeBlocks(document.children, registry, context)],
  };
}

function serializeBlocks(
  nodes: BlockNode[],
  registry: BlockRegistry,
  shared?: SerializeContext,
): RootContent[] {
  const context: SerializeContext = shared ?? {
    serializeChildren: (children) => serializeBlocks(children, registry),
  };
  const out: RootContent[] = [];
  for (const node of nodes) out.push(serializeBlock(node, registry, context));
  return out;
}

function serializeBlock(
  node: BlockNode,
  registry: BlockRegistry,
  context: SerializeContext,
): RootContent {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: node.children };
    case "heading":
      return { type: "heading", depth: node.depth, children: node.children };
    case "quote":
      return {
        type: "blockquote",
        children: serializeBlocks(node.children, registry, context) as never,
      };
    case "list":
      return {
        type: "list",
        ordered: node.ordered,
        ...(node.start !== undefined ? { start: node.start } : {}),
        spread: node.spread,
        children: node.children.map((item) => ({
          type: "listItem" as const,
          ...(item.checked !== undefined ? { checked: item.checked } : {}),
          spread: item.spread,
          children: serializeBlocks(item.children, registry, context) as never,
        })),
      };
    case "code":
      return {
        type: "code",
        ...(node.lang ? { lang: node.lang } : {}),
        ...(node.meta ? { meta: node.meta } : {}),
        value: node.value,
      };
    case "table":
      return {
        type: "table",
        align: node.align,
        children: node.children.map((row) => ({
          type: "tableRow" as const,
          children: row.children.map((cell) => ({
            type: "tableCell" as const,
            children: cell.children,
          })),
        })),
      };
    case "image": {
      const img: Image = { type: "image", url: node.url };
      if (node.alt) img.alt = node.alt;
      if (node.title) img.title = node.title;
      return { type: "paragraph", children: [img] };
    }
    case "thematicBreak":
      return { type: "thematicBreak" };
    case "footnoteDefinition":
      return {
        type: "footnoteDefinition",
        identifier: node.identifier,
        ...(node.label ? { label: node.label } : {}),
        children: serializeBlocks(node.children, registry, context) as never,
      };
    case "definition":
      return {
        type: "definition",
        identifier: node.identifier,
        ...(node.label ? { label: node.label } : {}),
        url: node.url,
        ...(node.title ? { title: node.title } : {}),
      };
    case "unknown-directive":
      return {
        type: "containerDirective",
        name: node.name,
        attributes: node.attributes,
        children: serializeBlocks(
          node.children,
          registry,
          context,
        ) as ContainerDirective["children"],
      };
    case "invalid-block":
      return serializeInvalid(node, registry, context);
    default:
      return serializeDirectiveBlock(node, registry, context);
  }
}

function serializeInvalid(
  node: Extract<BlockNode, { type: "invalid-block" }>,
  registry: BlockRegistry,
  context: SerializeContext,
): RootContent {
  if (node.originalType === "html" && node.source !== undefined) {
    return { type: "html", value: node.source };
  }
  // Re-emit as its original directive with preserved attributes (§15.2).
  return {
    type: "containerDirective",
    name: node.originalType,
    attributes: node.attributes,
    children: serializeBlocks(node.children, registry, context) as ContainerDirective["children"],
  };
}

function serializeDirectiveBlock(
  node: BlockNode,
  registry: BlockRegistry,
  context: SerializeContext,
): RootContent {
  const name = node.type === "runtime" ? node.runtime : node.type;
  const def = registry.get(name);
  if (!def) {
    // Should not happen for built-ins; fall back to an empty paragraph to avoid data loss of siblings.
    return { type: "paragraph", children: [] as PhrasingContent[] };
  }
  return def.toDirective(node, context) as unknown as RootContent;
}
```

- [ ] **Step 4: Write `src/serializer/index.ts`**

```ts
import type { NotebookDocument } from "../ast/nodes.js";
import type { BlockRegistry } from "../registry/types.js";
import { createRegistry } from "../registry/builtins.js";
import { documentToMdast } from "./to-mdast.js";
import { mdastToMarkdown } from "./to-markdown.js";

export { documentToMdast } from "./to-mdast.js";
export { mdastToMarkdown } from "./to-markdown.js";

export function serialize(
  document: NotebookDocument,
  registry: BlockRegistry = createRegistry(),
): string {
  return mdastToMarkdown(documentToMdast(document, registry));
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test -- to-mdast`
Expected: all pass. If frontmatter isn't emitted, confirm `remark-frontmatter` is on the processor (it is via `createProcessor`).

- [ ] **Step 6: Commit**

```bash
git add packages/document-engine/src/serializer
git commit -m "feat: document-engine semantic-AST-to-markdown serializer"
```

---

### Task 11: Public API assembly (W3)

**Files:**

- Modify: `packages/document-engine/src/index.ts`
- Create: `packages/document-engine/src/engine.ts`
- Create: `packages/document-engine/src/engine.test.ts`

**Interfaces:**

- Consumes: parse/importLegacy (Task 9), serialize (Task 10), validateDocument (Task 9), extractText (Task 8), migrateDocument (Task 7), createRegistry (Task 6).
- Produces: `createDocumentEngine(registry?): DocumentEngine`; re-exports of all public types and functions per the design spec §6.

- [ ] **Step 1: Write the failing test `src/engine.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createDocumentEngine } from "./engine.js";

describe("DocumentEngine", () => {
  it("parses, validates, serializes, and extracts text", () => {
    const engine = createDocumentEngine();
    const md =
      '---\nglyphquire-spec: 1\n---\n\n# GPU\n\n:::callout{type="warning" title="Limit"}\nshared memory\n:::\n';
    const parsed = engine.parse(md);
    expect(parsed.specVersion).toBe(1);
    expect(engine.validate(parsed.document).valid).toBe(true);
    expect(engine.serialize(parsed.document)).toContain(":::callout");
    expect(engine.extractText(parsed.document)).toContain("GPU");
  });

  it("migrate v1->v1 is identity", () => {
    const engine = createDocumentEngine();
    const md = "---\nglyphquire-spec: 1\n---\n\n# Hi\n";
    expect(engine.migrate(md, 1, 1).markdown).toBe(md);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `pnpm --filter @glyphquire/document-engine test -- engine`
Expected: FAIL.

- [ ] **Step 3: Write `src/engine.ts`**

```ts
import type { NotebookDocument } from "./ast/nodes.js";
import type { BlockRegistry } from "./registry/types.js";
import { createRegistry } from "./registry/builtins.js";
import { parse, importLegacy, type ParseResult } from "./parser/index.js";
import { serialize } from "./serializer/index.js";
import { validateDocument, type ValidationResult } from "./validation/validate.js";
import { extractText } from "./text/extract.js";
import { migrateDocument, type MigrationResult } from "./migration/migrate.js";

export interface DocumentEngine {
  parse(markdown: string): ParseResult;
  importLegacy(markdown: string, assumedVersion: number): ParseResult;
  validate(document: NotebookDocument): ValidationResult;
  serialize(document: NotebookDocument): string;
  migrate(markdown: string, from: number, to: number): MigrationResult;
  extractText(document: NotebookDocument): string;
}

export function createDocumentEngine(registry: BlockRegistry = createRegistry()): DocumentEngine {
  return {
    parse: (markdown) => parse(markdown, registry),
    importLegacy: (markdown, assumedVersion) => importLegacy(markdown, assumedVersion, registry),
    validate: (document) => validateDocument(document),
    serialize: (document) => serialize(document, registry),
    migrate: (markdown, from, to) => migrateDocument(markdown, from, to),
    extractText: (document) => extractText(document),
  };
}
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
export const DOCUMENT_ENGINE_PACKAGE = "@glyphquire/document-engine";

export * from "./ast/index.js";
export * from "./validation/index.js";
export * from "./registry/index.js";
export { parse, importLegacy, type ParseResult } from "./parser/index.js";
export { serialize, documentToMdast, mdastToMarkdown } from "./serializer/index.js";
export { extractText } from "./text/extract.js";
export {
  migrateDocument,
  CURRENT_SPEC_VERSION,
  type MigrationResult,
} from "./migration/migrate.js";
export { createDocumentEngine, type DocumentEngine } from "./engine.js";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test`
Expected: entire suite passes.

- [ ] **Step 6: Commit**

```bash
git add packages/document-engine/src/index.ts packages/document-engine/src/engine.ts packages/document-engine/src/engine.test.ts
git commit -m "feat: document-engine public API and DocumentEngine factory"
```

---

### Task 12: Golden fixtures + fixture-driven tests (W4)

**Files:**

- Create: `packages/document-engine/tests/fixtures/**` (data)
- Create: `packages/document-engine/src/__tests__/fixtures.test.ts`

**Interfaces:**

- Consumes: `createDocumentEngine`, `semanticNormalize`.
- Produces: golden fixtures per MARKDOWN_SPEC.md §59 and a harness that, for each fixture directory, asserts `parse(input.md)` matches `expected.ast.json` (normalized) and `serialize(parse(input.md).document)` matches `expected.md`.

Fixture directory shape: `tests/fixtures/<group>/<case>/{input.md, expected.ast.json, expected.md}`.

- [ ] **Step 1: Create version-handling fixtures**

Create these directories with `input.md` files (and `expected.ast.json`/`expected.md` generated in Step 4):

- `tests/fixtures/version/missing-version-marker/input.md` → `# Hi\n`
- `tests/fixtures/version/invalid-version-non-positive/input.md` → `---\nglyphquire-spec: 0\n---\n`
- `tests/fixtures/version/invalid-version-non-integer/input.md` → `---\nglyphquire-spec: 1.5\n---\n`
- `tests/fixtures/version/unsupported-future-version/input.md` → `---\nglyphquire-spec: 2\n---\n\n# Hi\n`

- [ ] **Step 2: Create per-built-in fixtures**

For each built-in (`callout`, `sticky`, `toggle`, `tabs`, `columns`, `p5`, `canvas`) create at least `valid-minimal`, `valid-full`, `roundtrip`, `unknown-attribute`, `invalid-attribute-value` cases; for `callout`/`toggle` add `invalid-required-attribute`; for `tabs`/`columns` add `valid-nested`, `invalid-parent`, `invalid-child`. Example `tests/fixtures/callout/valid-full/input.md`:

```md
---
glyphquire-spec: 1
---

:::callout{type="warning" title="Note"}
Body text.
:::
```

Example `tests/fixtures/tabs/valid-nested/input.md`:

```md
---
glyphquire-spec: 1
---

::::tabs

:::tab{title="A"}
First.
:::

:::tab{title="B"}
Second.
:::

::::
```

- [ ] **Step 3: Write the fixture harness `src/__tests__/fixtures.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createDocumentEngine, semanticNormalize } from "../index.js";

const engine = createDocumentEngine();
const fixturesRoot = fileURLToPath(new URL("../../tests/fixtures/", import.meta.url));

function fixtureCases(root: string): string[] {
  const cases: string[] = [];
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const name of readdirSync(groupDir)) {
      const caseDir = join(groupDir, name);
      if (statSync(caseDir).isDirectory() && existsSync(join(caseDir, "input.md"))) {
        cases.push(caseDir);
      }
    }
  }
  return cases;
}

describe("golden fixtures", () => {
  for (const caseDir of fixtureCases(fixturesRoot)) {
    const label = caseDir.slice(fixturesRoot.length);
    it(`matches expected AST and markdown: ${label}`, () => {
      const input = readFileSync(join(caseDir, "input.md"), "utf8");
      const { document } = engine.parse(input);

      const astPath = join(caseDir, "expected.ast.json");
      if (existsSync(astPath)) {
        const expected = JSON.parse(readFileSync(astPath, "utf8"));
        expect(semanticNormalize(document)).toEqual(semanticNormalize(expected));
      }

      const mdPath = join(caseDir, "expected.md");
      if (existsSync(mdPath)) {
        const expectedMd = readFileSync(mdPath, "utf8");
        expect(engine.serialize(document)).toBe(expectedMd);
      }
    });
  }
});
```

- [ ] **Step 4: Generate `expected.ast.json` and `expected.md`**

For each fixture, run a one-off script to produce expected outputs, then hand-verify each is correct before committing (do not blindly trust generated output — read each `expected.md` and confirm it is valid canonical Notebook Markdown, and each AST matches the intended semantics). Example generation snippet (run with `node` via a temp script, then delete it):

```ts
import { createDocumentEngine } from "@glyphquire/document-engine";
import { readFileSync, writeFileSync } from "node:fs";
const engine = createDocumentEngine();
const input = readFileSync("tests/fixtures/callout/valid-full/input.md", "utf8");
const { document } = engine.parse(input);
writeFileSync(
  "tests/fixtures/callout/valid-full/expected.ast.json",
  JSON.stringify(document, null, 2) + "\n",
);
writeFileSync("tests/fixtures/callout/valid-full/expected.md", engine.serialize(document));
```

- [ ] **Step 5: Run the fixture suite**

Run: `pnpm --filter @glyphquire/document-engine test -- fixtures`
Expected: every fixture case passes.

- [ ] **Step 6: Commit**

```bash
git add packages/document-engine/tests/fixtures packages/document-engine/src/__tests__/fixtures.test.ts
git commit -m "test: document-engine golden fixtures and harness"
```

---

### Task 13: Round-trip invariant + property tests (W4)

**Files:**

- Create: `packages/document-engine/src/__tests__/round-trip.test.ts`
- Create: `packages/document-engine/src/__tests__/property.test.ts`

**Interfaces:**

- Consumes: `createDocumentEngine`, `semanticNormalize`, `migrateDocument`; `fast-check`.
- Produces: the §36 round-trip invariant suite over representative documents and the §60 property suite.

- [ ] **Step 1: Write `src/__tests__/round-trip.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createDocumentEngine, semanticNormalize } from "../index.js";

const engine = createDocumentEngine();

const DOCS: string[] = [
  "---\nglyphquire-spec: 1\n---\n\n# Title\n\nParagraph with **bold** and `code`.\n",
  '---\nglyphquire-spec: 1\n---\n\n:::callout{type="danger" title="Sec"}\nNever run this.\n:::\n',
  '---\nglyphquire-spec: 1\n---\n\n::::columns{count="2"}\n\n:::column\nLeft\n:::\n\n:::column\nRight\n:::\n\n::::\n',
  '---\nglyphquire-spec: 1\n---\n\n::::tabs\n\n:::tab{title="A"}\nAlpha\n:::\n\n::::\n',
  '---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nkeep me\n:::\n',
];

describe("round-trip invariant (§36)", () => {
  for (const [index, md] of DOCS.entries()) {
    it(`preserves semantics for document ${index}`, () => {
      const ast1 = engine.parse(md).document;
      const ast2 = engine.parse(engine.serialize(ast1)).document;
      expect(semanticNormalize(ast2)).toEqual(semanticNormalize(ast1));
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @glyphquire/document-engine test -- round-trip`
Expected: PASS. If a case fails, the offending block's `toDirective`/`fromDirective` are not inverse — fix the block, not the test.

- [ ] **Step 3: Write `src/__tests__/property.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createDocumentEngine, semanticNormalize, migrateDocument } from "../index.js";

const engine = createDocumentEngine();

describe("properties (§60)", () => {
  it("parse never throws on arbitrary UTF-8", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString(), (s) => {
        expect(() => engine.parse(s)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it("serialize(parse(valid)) preserves semantics for prefixed documents", () => {
    fc.assert(
      fc.property(fc.lorem({ maxCount: 8 }), (body) => {
        const md = `---\nglyphquire-spec: 1\n---\n\n${body}\n`;
        const ast1 = engine.parse(md).document;
        const ast2 = engine.parse(engine.serialize(ast1)).document;
        expect(semanticNormalize(ast2)).toEqual(semanticNormalize(ast1));
      }),
      { numRuns: 200 },
    );
  });

  it("migrate v1->v1 is identity", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(migrateDocument(s, 1, 1).markdown).toBe(s);
      }),
    );
  });
});
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `pnpm --filter @glyphquire/document-engine typecheck`
Run: `pnpm --filter @glyphquire/document-engine test`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add packages/document-engine/src/__tests__/round-trip.test.ts packages/document-engine/src/__tests__/property.test.ts
git commit -m "test: document-engine round-trip invariant and property tests"
```

---

## Integration Validation (after Task 13)

- [ ] Run `pnpm install` at the root.
- [ ] Run `pnpm typecheck` — all workspace packages clean.
- [ ] Run `pnpm lint` — zero errors.
- [ ] Run `pnpm build` — all packages build.
- [ ] Run `pnpm test` — full workspace suite green.
- [ ] Confirm `packages/document-engine` imports nothing from `apps/*` and no DOM/framework packages.
