# MARKDOWN_SPEC.md — Notebook Markdown Specification

> Status: Draft v0.1  
> Specification ID: Notebook Markdown v0.1  
> Canonical format: UTF-8 Markdown text  
> Base dialect: GitHub Flavored Markdown (GFM)  
> Extension grammar: Generic Directives (`remark-directive` compatible)  
> Architecture: Markdown → MDAST → Notebook Semantic AST  
> Parser stack: `unified` + `remark-parse` + `remark-gfm` + `remark-directive` + `remark-frontmatter`  
> Serializer stack: `mdast-util-to-markdown` with GFM, directive, and frontmatter extensions  
> Last updated: 2026-08-20

## 1. Purpose

Notebook Markdown 是本產品的 canonical document format。

設計目標：

1. 一般使用者能使用熟悉的 Markdown。
2. 透過少量可預測的 extension syntax 建立 styled / interactive blocks。
3. 文件離開本產品後仍盡可能保持可閱讀。
4. Parser 與 serializer 必須支援穩定 round-trip。
5. Syntax 描述語意，不暴露 Vue、Tailwind、DOM 或任意 CSS implementation。
6. Milkdown Visual Mode 與 CodeMirror Source Mode 共用同一份 canonical Markdown。
7. 第三方與 user-defined blocks 使用同一 directive grammar。
8. executable blocks 必須明確區分並進入 sandbox runtime。
9. syntax version 必須可 migration。
10. parser 遇到未知或錯誤 syntax 時應優先保存資料，而非破壞內容。

---

## 2. Normative Terms

本規格使用以下詞彙：

- MUST：實作必須遵守。
- MUST NOT：實作不得採用。
- SHOULD：除非有充分理由，實作應遵守。
- SHOULD NOT：通常不應使用。
- MAY：可選行為。

---

## 3. Canonical Source

資料庫 canonical state：

```text
UTF-8 Markdown text
```

以下均非 canonical：

- MDAST
- Notebook Semantic AST
- ProseMirror document
- Milkdown state
- CodeMirror state
- rendered HTML
- search text
- cached preview
- exported document

Canonical Markdown MUST 可在沒有 Visual Editor 的情況下被讀取與編輯。

---

## 4. Parsing Pipeline

```text
Markdown source
      │
      ▼
unified / remark-parse
      │
      ├─ remark-gfm (GFM extensions)
      ├─ remark-directive (directive extension)
      └─ remark-frontmatter (glyphquire-spec YAML)
      │
      ▼
MDAST
      │
      ▼
Directive recognition
      │
      ▼
Semantic validation
      │
      ▼
Notebook Semantic AST
```

Concrete parser stack is `unified` + `remark-parse` + `remark-gfm` + `remark-directive` + `remark-frontmatter`; serialization uses `mdast-util-to-markdown` with the matching GFM, directive, and frontmatter extensions. Implementations MUST NOT hand-concatenate directive or attribute text (see §12, §34).

Milkdown 使用獨立 side path：

```text
Markdown
   │
   ▼
Remark / MDAST
   │
   ↕
Milkdown Transformer
   │
   ↕
ProseMirror
```

Notebook Semantic AST MUST NOT 成為 Milkdown 必須理解的中介格式。

---

## 5. Base Markdown Dialect

Notebook Markdown v0.1 以 GFM 為 base dialect。

v0.1 支援：

- paragraphs
- ATX headings
- emphasis
- strong emphasis
- strikethrough
- inline code
- fenced code blocks
- links
- images
- blockquotes
- ordered lists
- unordered lists
- task lists
- tables
- thematic breaks
- autolink literals
- footnotes
- hard/soft line breaks

---

## 6. Raw HTML

v0.1：

```text
raw HTML = disabled
```

Parser MAY 保留 unknown raw HTML source for diagnostics/import recovery，但 renderer MUST NOT 將 raw HTML 直接注入 application DOM。

Visual Editor SHOULD 將 raw HTML 顯示成 unsupported/raw block。

後續版本若允許 HTML，必須建立獨立 sanitization policy。

---

## 7. Headings

Canonical syntax：

```md
# H1

## H2

### H3

#### H4

##### H5

###### H6
```

Setext heading：

```md
Title
=====
```

v0.1 parser MAY 接受，但 serializer SHOULD normalize 為 ATX heading。

Heading 的 sparkle、line、font、animation 等均屬 Theme Engine：

```md
# Architecture
```

同一份 Markdown 可以被 theme render 為不同視覺樣式。

不得新增：

```md
✦# Architecture
```

作為 semantic syntax。

---

## 8. Blockquotes

標準 Markdown：

```md
> This is a quote.
```

MDAST：

```ts
{
  type: "blockquote",
  children: [...]
}
```

Notebook AST：

```ts
interface QuoteNode {
  type: "quote";
  children: BlockNode[];
}
```

Sticky-note style 是 renderer/theme variant；普通 quote 不需要 custom directive。

若使用者需要明確 semantic sticky note，使用：

```md
:::sticky
Remember this.
:::
```

---

## 9. Directive Grammar

Notebook extensions 採 Generic Directives。

三種 directive：

```text
container directive
leaf directive
text directive
```

v0.1 product features 主要使用 container directives。

---

## 10. Container Directive

基本語法：

```md
:::name
content
:::
```

attributes：

```md
:::name{key="value" flag="true"}
content
:::
```

example：

```md
:::callout{type="warning" title="注意"}
MPS does not isolate GPU memory.
:::
```

directive name MUST：

- 使用 ASCII lowercase
- 以英文字母開始
- 只能使用 `a-z`, `0-9`, `-`
- 最長 64 characters

valid：

```text
callout
sticky
my-block
chart2
```

invalid：

```text
Callout
my_block
123block
my block
```

User-defined block SHOULD 使用 namespace：

```text
user-rating
team-roadmap
plugin-chart
```

Built-in names 保留。

---

## 11. Directive Attributes

Canonical attribute syntax：

```md
:::callout{type="warning" title="Important" collapsible="false"}
...
:::
```

Rules：

1. Attribute key MUST 符合：

```regex
^[a-z][a-z0-9-]{0,63}$
```

2. Serializer MUST 使用 double-quoted string value。
3. Boolean values canonical form：

```text
"true"
"false"
```

4. Number canonical form：

```text
"1"
"42"
"3.14"
```

5. Semantic validator 負責將 string attribute coercion 成 block schema type。
6. Unknown attribute 的處理取決於 block schema。
   v0.1 built-in schemas use an explicit strip policy: unknown attributes are
   omitted from the semantic AST and canonical output, without a mandatory
   `ATTRIBUTE_UNKNOWN` diagnostic. Future schemas may choose a reporting
   policy; this does not require universal unknown-attribute detection。
7. Attribute order 不具 semantic meaning。
8. Serializer SHOULD 使用 schema-defined deterministic order。

Example input：

```md
:::callout{title="Warning" type="warning"}
...
:::
```

Canonical output MAY normalize：

```md
:::callout{type="warning" title="Warning"}
...
:::
```

---

## 12. Attribute Escaping

String 中 double quote 與 backslash MUST escaping。

Conceptually：

```text
\"
\\
```

Attribute parser behavior 以 generic directive implementation 為 syntax source of truth。

Serializer MUST 使用 underlying directive serializer，避免自行拼接 attribute text。

---

## 13. Nested Directives

Container directives MAY nesting。

外層 fence MUST 比內層使用更多 colon，避免 ambiguity。

Example：

```md
::::columns{count="2"}

:::callout{type="info"}
Left column.
:::

:::callout{type="warning"}
Right column.
:::

::::
```

Serializer MUST 選擇足以包住 children 的 delimiter length。

Application code MUST NOT 假設所有 container fence 都恰好三個 colon。

---

## 14. Unknown Directives

Example：

```md
:::future-widget{foo="bar"}
content
:::
```

Parser 能建立 generic directive MDAST node。

Semantic transform 找不到 registry definition 時建立：

```ts
interface UnknownDirectiveNode {
  type: "unknown-directive";
  directiveType: "container" | "leaf" | "text";
  name: string;
  attributes: Record<string, string>;
  source?: string;
  children: BlockNode[];
}
```

Rules：

- MUST NOT execute.
- MUST NOT silently discard.
- SHOULD preserve enough information for round-trip.
- Visual Editor SHOULD 顯示 Unsupported Block。
- Source Mode MUST 保留原始 Markdown。
- export SHOULD preserve directive syntax.

這讓新版 plugin 建立的文件在舊版 app 中仍不至於資料遺失。

---

## 15. Invalid Directives

Invalid directive 分兩類。

### 15.1 Syntax-invalid

Markdown/directive parser 無法形成正確 directive。

行為：

- Source Mode 顯示 syntax diagnostic。
- autosave MAY 儲存原始 Markdown draft。
- Visual Mode 不得用壞掉的 AST 覆蓋 source。
- renderer MUST fail safely。

### 15.2 Schema-invalid

Syntax 合法，但 properties 不符合 block schema。

Example：

```md
:::callout{type="banana"}
...
:::
```

若 `banana` 不在 enum：

Semantic AST：

```ts
interface InvalidBlockNode {
  type: "invalid-block";
  originalType: string;
  errors: ValidationIssue[];
  sourceNode: unknown;
}
```

Visual Editor 顯示 block + diagnostic。

Serializer SHOULD 保留原 attribute，除非使用者修正。

---

## 16. Semantic AST

Notebook AST 與 parser MDAST 分離。

Root：

```ts
interface NotebookDocument {
  type: "document";
  specVersion: 1;
  children: BlockNode[];
}
```

Block union：

```ts
type BlockNode =
  | ParagraphNode
  | HeadingNode
  | QuoteNode
  | ListNode
  | CodeNode
  | TableNode
  | ImageNode
  | CalloutNode
  | StickyNode
  | ToggleNode
  | TabsNode
  | ColumnsNode
  | RuntimeNode
  | CustomBlockNode
  | UnknownDirectiveNode
  | InvalidBlockNode;
```

Semantic AST 只描述 application domain。

不得包含：

```text
Tailwind class
Vue component instance
DOM node
CSSStyleDeclaration
ProseMirror Node
Milkdown Context
```

---

## 17. MDAST → Semantic AST

Example Markdown：

```md
:::callout{type="warning" title="注意"}
GPU memory is shared.
:::
```

MDAST concept：

```ts
{
  type: "containerDirective",
  name: "callout",
  attributes: {
    type: "warning",
    title: "注意"
  },
  children: [...]
}
```

Semantic transform：

```ts
{
  type: "callout",
  version: 1,
  props: {
    variant: "warning",
    title: "注意"
  },
  children: [...]
}
```

Mapping MUST 經 Component Registry。

---

## 18. Component Registry Contract

Conceptual interface：

```ts
interface BlockDefinition<TProps, TNode extends BlockNode> {
  name: string;
  version: number;
  kind: "container" | "leaf" | "text";

  schema: Schema<TProps>;

  fromDirective(node: DirectiveMdastNode, context: TransformContext): TNode;

  toDirective(node: TNode, context: SerializeContext): DirectiveMdastNode;

  capabilities: BlockCapability[];
}
```

Built-in 與 declarative user-defined blocks 使用同一 registry lookup。

---

## 19. Reserved Built-in Directive Names

v0.1 保留：

```text
callout
sticky
toggle
tabs
tab
columns
column
p5
canvas
```

User-defined blocks MUST NOT overwrite built-in definitions。

Future reserved names SHOULD be introduced through spec migration。

---

# Built-in Blocks

## 20. Callout

Syntax：

```md
:::callout{type="info" title="Information"}
Content.
:::
```

### 20.1 Properties

```ts
interface CalloutProps {
  type: "info" | "note" | "tip" | "warning" | "danger" | "success";
  title?: string;
  icon?: string;
}
```

Defaults：

```text
type = "info"
title = undefined
icon = theme/default
```

### 20.2 Valid examples

```md
:::callout
Default information callout.
:::
```

```md
:::callout{type="danger" title="Security"}
Never execute this in the main origin.
:::
```

### 20.3 Invalid example

```md
:::callout{type="rainbow"}
...
:::
```

`rainbow` is schema-invalid in v0.1.

### 20.4 Semantic AST

```ts
interface CalloutNode {
  type: "callout";
  version: 1;
  props: CalloutProps;
  children: BlockNode[];
}
```

Hover、border animation、glow 等全部由 theme variant 決定。

---

## 21. Sticky Note

Syntax：

```md
:::sticky
Remember to review this.
:::
```

Properties：

```ts
interface StickyProps {
  tone?: "default" | "yellow" | "pink" | "blue" | "green";
  title?: string;
}
```

Example：

```md
:::sticky{tone="yellow" title="Todo"}
Review Chapter 5.
:::
```

`tone` 是 semantic theme hint，不保證直接映射到特定 hex color。

---

## 22. Toggle

Syntax：

```md
:::toggle{title="More details"}
Hidden **Markdown** content.

- Item A
- Item B
  :::
```

Properties：

```ts
interface ToggleProps {
  title: string;
  open?: boolean;
}
```

Rules：

- `title` MUST be non-empty.
- `open` default false.
- nested block content allowed.
- renderer MUST expose keyboard accessible control.
- renderer SHOULD use `aria-expanded`.

Canonical：

```md
:::toggle{title="More details" open="false"}
...
:::
```

Serializer MAY omit default `open="false"`。

---

## 23. Tabs

Tabs 使用 parent/child directives。

```md
::::tabs

:::tab{title="Vue"}
Vue content.
:::

:::tab{title="Svelte"}
Svelte content.
:::

::::
```

### 23.1 Tabs schema

```ts
interface TabsNode {
  type: "tabs";
  version: 1;
  children: TabNode[];
}

interface TabNode {
  type: "tab";
  version: 1;
  props: {
    title: string;
  };
  children: BlockNode[];
}
```

Rules：

- `tab` SHOULD only be direct child of `tabs`.
- `tabs` MUST contain at least one `tab`.
- duplicate titles MAY be accepted but validator SHOULD warn.
- non-`tab` child SHOULD produce schema diagnostic.

---

## 24. Columns

Syntax：

```md
::::columns{count="2"}

:::column
Left.
:::

:::column
Right.
:::

::::
```

Properties：

```ts
interface ColumnsProps {
  count?: 2 | 3 | 4;
  gap?: "sm" | "md" | "lg";
}
```

Rules：

- default count SHOULD infer from child count when valid.
- maximum v0.1 columns = 4.
- responsive renderer MAY stack columns on narrow screens.
- content order remains source order.

`column` SHOULD only be child of `columns`。

---

## 25. p5 Runtime Block

Canonical syntax SHOULD use directive form：

````md
:::p5{height="400"}

```js
function setup() {
  createCanvas(600, 400);
}

function draw() {
  background(245);
  circle(mouseX, mouseY, 30);
}
```
````

:::

`````

This explicit wrapper is preferred over assigning special behavior to every fenced code block because runtime metadata belongs to the semantic block.

A shorthand MAY be supported by editor import:

````md
```p5
...
`````

`````

Serializer SHOULD normalize shorthand to the canonical directive form if runtime metadata is required.

### 25.1 Props

```ts
interface P5RuntimeProps {
  height?: number;
  network?: string[];
  autoplay?: boolean;
}
```

Defaults：

```text
height = 400
network = []
autoplay = false
```

### 25.2 Network

Default：

```text
network = []
```

Explicit request：

```md
:::p5{network="https://api.example.com"}
...
:::
```

Multiple origins SHOULD use a structured encoded attribute selected by implementation, or v0.2 may introduce repeatable/array syntax.

Until array grammar is formally specified, v0.1 RECOMMENDS a single origin attribute:

```text
network="https://api.example.com"
```

Multiple origins MAY be configured through editor UI and serialized by a future spec version.

This deliberately avoids inventing JSON-in-attribute syntax in v0.1.

### 25.3 Runtime rule

p5 source MUST execute only in Sandbox Runtime Manager.

Main application MUST NOT:

```ts
eval(source)
new Function(source)
```

inside app origin.

---

## 26. Canvas Runtime Block

Syntax：

```md
:::canvas{height="320"}
```js
const ctx = canvas.getContext("2d");
ctx.fillRect(10, 10, 100, 100);
```
:::
```

Runtime API exposed inside sandbox is implementation-defined but MUST be versioned.

Semantic AST：

```ts
interface RuntimeNode {
  type: "runtime";
  version: 1;
  runtime: "p5" | "canvas";
  props: RuntimeProps;
  source: string;
}
```

---

# Assets

## 27. Images

External standard Markdown image remains valid：

```md
![Alt text](https://example.com/image.png)
```

Managed product asset canonical form：

```md
![Architecture](asset://01JABCDEF1234567890)
```

Rules：

- `asset://` identifies application asset ID.
- canonical Markdown MUST NOT contain MinIO/R2 presigned URLs.
- renderer resolves logical URI using Asset Resolver.
- serializer preserves logical URI.
- export can rewrite asset URI according to export target.

---

## 28. Attachments

v0.1 generic attachment：

```md
[Download dataset](asset://01JDATASET123)
```

Renderer MAY decorate managed asset links using metadata.

No separate attachment directive is required for v0.1.

---

# User-defined Blocks

## 29. Declarative Custom Blocks

Users can define block schemas without executing arbitrary main-app JavaScript.

Example manifest concept：

```json
{
  "name": "user-rating",
  "version": 1,
  "kind": "container",
  "props": {
    "value": {
      "type": "number",
      "min": 0,
      "max": 5
    },
    "label": {
      "type": "string"
    }
  },
  "renderer": {
    "preset": "rating"
  }
}
```

Markdown：

```md
:::user-rating{value="4" label="Readability"}
Optional description.
:::
```

Semantic AST：

```ts
interface CustomBlockNode {
  type: "custom-block";
  definitionId: string;
  definitionVersion: number;
  props: Record<string, unknown>;
  children: BlockNode[];
}
```

Definition lifecycle：

- 每個 declarative definition MUST belong to exactly one workspace。
- Published definition version MUST be immutable。
- Schema、renderer behavior 或 capability 變更 MUST publish a new positive integer `definitionVersion`。
- Built-in names remain reserved and MUST NOT be shadowed。
- Disabled、deleted、unknown 或 unavailable definition MUST render an unsupported placeholder while preserving the original directive for round-trip serialization。
- Cross-workspace definition resolution is invalid。
- Executable third-party blocks are outside P0。

Production release priority and evidence: see `SPEC.md` §49 Production Readiness Contract。

---

## 30. Custom Block Constraints

Detailed requirement: see §29。

v0.1 user definition MAY specify：

- block name
- title/description
- property schema
- defaults
- enums
- number limits
- nested-content policy
- approved renderer preset
- icon
- theme token hooks
- approved runtime capability

MUST NOT specify：

- Vue SFC
- React component
- arbitrary browser JS in main origin
- arbitrary server JS
- Tailwind source
- unrestricted CSS
- database queries
- filesystem operations
- internal API credentials

---

## 31. Renderer Presets

Initial approved declarative renderer primitives MAY include：

```text
card
callout
badge
rating
key-value
progress
stack
grid
list
```

Exact preset collection belongs to Component SDK, not Markdown grammar。

A user-defined block remains valid even if a particular client lacks its renderer preset; it becomes unsupported/unknown UI while source is preserved.

---

# Themes

## 32. Theme Independence

Markdown MUST NOT encode theme names for normal content.

Do not write：

```md
:::callout{css="glow-red-shadow"}
```

Use semantic property：

```md
:::callout{type="danger"}
```

Theme decides:

```text
border
background
shadow
animation
font
spacing
decoration
```

---

## 33. Theme-level User Customization

v0.1：

```text
Design Tokens
+
approved component variants
```

No unrestricted CSS。

Example theme config：

```json
{
  "tokens": {
    "accent": "#..."
  },
  "components": {
    "heading": {
      "decoration": "sparkle"
    },
    "callout": {
      "surface": "glass",
      "animation": "glow"
    }
  }
}
```

Theme config is separate from Markdown document.

---

# Serialization

## 34. Serializer Requirements

Serializer MUST:

1. Produce valid Notebook Markdown.
2. Preserve semantic content.
3. Use directive serializer rather than string concatenation.
4. Produce deterministic attribute ordering where schema defines order.
5. Omit default values where doing so is unambiguous.
6. Use sufficient directive fence length for nesting.
7. Preserve unsupported directive data where possible.
8. Never serialize storage-derived signed URL as canonical `asset://` replacement.

---

## 35. Canonical Formatting

v0.1 canonical preferences：

- UTF-8
- LF line endings
- ATX headings
- fenced code blocks with backticks
- double-quoted directive attributes
- lowercase directive names
- blank line around block directives where structurally useful
- trailing newline at EOF

Formatting is not semantic。

---

## 36. Round-trip Invariant

For any valid supported document `M`：

```text
AST1 = parse(M)
M2   = serialize(AST1)
AST2 = parse(M2)
```

Requirement：

```text
semanticNormalize(AST1)
===
semanticNormalize(AST2)
```

Byte-identical Markdown is NOT required。

---

## 37. Unknown-block Round-trip

For unknown directive：

```md
:::plugin-future{x="1"}
Hello.
:::
```

App MUST avoid turning it into plain text or discarding attributes。

Ideal：

```text
parse
→ UnknownDirectiveNode
→ serialize
→ semantically equivalent directive
```

---

# Visual Editor

## 38. Milkdown Mapping

Milkdown custom nodes map against MDAST directive nodes。

Example：

```text
containerDirective(name=callout)
      ↕
Milkdown callout ProseMirror node
```

Milkdown integration MUST define both：

- `parseMarkdown`
- `toMarkdown`

A block feature is not considered complete until both directions exist。

---

## 39. Visual/Source Mode Switching

Source → Visual：

```text
CodeMirror Markdown
→ parse
→ diagnostics
→ if safe, load Milkdown
```

If fatal parse error exists：

- source remains authoritative
- user receives diagnostic
- application MUST NOT overwrite source with stale Visual state

Visual → Source：

```text
Milkdown
→ Remark/MDAST serialization
→ Markdown
→ validation
→ CodeMirror
```

---

## 40. Unsupported Block in Visual Mode

Visual representation SHOULD contain：

```text
Unsupported block: plugin-future
[Edit source]
```

It MUST NOT silently disappear。

If practical, child Markdown SHOULD remain visible/readable。

---

# Diagnostics

## 41. Diagnostic Model

```ts
interface DocumentDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  range?: {
    from: number;
    to: number;
  };
  block?: string;
  attribute?: string;
}
```

Examples：

```text
DIRECTIVE_UNKNOWN
DIRECTIVE_INVALID_NAME
ATTRIBUTE_UNKNOWN
ATTRIBUTE_INVALID_VALUE
ATTRIBUTE_REQUIRED
INVALID_PARENT
INVALID_CHILD
UNSUPPORTED_SPEC_VERSION
RUNTIME_NETWORK_DENIED
ASSET_NOT_FOUND
```

---

## 42. Error Recovery

Parser should recover as much as possible.

Principle：

```text
Preserve source > perfect visual rendering
```

A broken custom block MUST NOT cause unrelated document content to disappear。

---

# Search Text

## 43. Search Extraction

Search text comes from Semantic AST。

Included：

- heading text
- paragraph text
- quote text
- list text
- callout title/content
- sticky title/content
- toggle title/content
- tab titles/content
- asset alt text
- user custom block textual props designated searchable

Excluded by default：

- directive names
- CSS/theme tokens
- runtime source code
- generated HTML
- opaque asset ID

Code block search MAY be a separate searchable field later。

---

# Security Semantics

## 44. Executable vs Non-executable Blocks

Every registered block MUST declare capability：

```ts
type BlockCapability =
  | "static"
  | "interactive-ui"
  | "sandbox-runtime"
  | "network-request";
```

Static blocks MUST NOT cause script execution。

Runtime blocks MUST route through sandbox。

---

## 45. Network Capability

v0.1 default：

```text
deny
```

Requested origin MUST be：

- absolute HTTPS origin in production
- matched against user/workspace/runtime policy
- passed as capability to sandbox
- absent from auth credentials

`localhost` MAY be allowed in development policy only。

---

## 46. Links

Renderer MUST reject dangerous URL schemes such as executable script URLs。

Supported normal schemes SHOULD include：

```text
https
http
mailto
asset
```

Actual allowlist is security policy, not author-controlled。

---

# Versioning

## 47. Specification Version

Canonical GlyphQuire Markdown MUST include the reserved YAML frontmatter field `glyphquire-spec` with a positive integer version：

```yaml
---
glyphquire-spec: 1
---
```

Parser MUST expose this version to the migration layer。Standalone Markdown and exported bundles MUST retain it。

Versionless input is legacy input。Import MUST follow an explicit legacy policy and MUST NOT guess a version before destructive migration。

Database metadata MAY duplicate the version for indexing。A database/Markdown version mismatch is an error；Markdown remains authoritative。

Application revision history、legacy import 與 production evidence：see `SPEC.md` §19。

---

## 48. Migration

Canonical version identity：see §47。

Concept：

```ts
migrateDocument(
  markdown: string,
  fromVersion: number,
  toVersion: number
): MigrationResult
```

Migration MUST：

- preserve source on failure
- produce diagnostics
- be deterministic
- have fixtures
- create version snapshot before destructive migration

---

## 49. Block Versioning

Canonical notebook version identity：see §47。Declarative definition lifecycle：see §29。

Built-in semantic nodes carry their own definition version：

```ts
{
  type: "callout",
  version: 1
}
```

Markdown directive does not normally expose this version。

Migration layer knows mapping：

```text
Notebook Spec version
→ block definition versions
```

User custom blocks record definition version in their registry metadata。Notebook Spec version and definition version mapping MUST be deterministic。

---

# Import / Export Compatibility

## 50. Plain Markdown Readers

A goal is graceful degradation。

Example：

```md
:::callout{type="warning"}
Important text.
:::
```

A Markdown implementation without directive support may show punctuation around still-readable text。

This is preferable to embedding opaque JSON blobs as primary content。

---

## 51. Obsidian Compatibility

v0.1 does not claim full Obsidian syntax compatibility。

Potential importer can map：

```text
Obsidian callout
→ Notebook callout directive
```

Importer behavior belongs to import adapter, not canonical grammar。

---

## 52. Export to Generic Markdown

Generic Markdown export MAY convert semantic blocks：

```text
callout → blockquote
toggle  → heading + content
tabs    → headings
columns → sequential content
runtime → fenced code
```

Canonical Notebook Markdown export MUST preserve directives。

---

# Examples

## 53. Example Document

````md
---
glyphquire-spec: 1
---

# GPU Scheduling

This note studies heterogeneous GPU scheduling.

:::callout{type="warning" title="MPS limitation"}
MPS controls compute sharing but should not be treated as a complete memory-isolation mechanism.
:::

:::sticky{tone="yellow" title="Experiment"}
Remember to compare RTX 4070 and RTX 3080 separately.
:::

:::toggle{title="Experiment details"}
- 40 jobs
- 60 jobs
- 80 jobs
- 100 jobs
:::

::::tabs

:::tab{title="SAC"}
Off-policy actor-critic.
:::

:::tab{title="PPO"}
On-policy baseline.
:::

::::

::::columns{count="2"}

:::column
## Left

Architecture notes.
:::

:::column
## Right

Evaluation notes.
:::

::::

![Architecture](asset://01JABCDEF1234567890)

:::p5{height="400"}
```js
function setup() {
  createCanvas(600, 400)
}

function draw() {
  background(245)
  circle(mouseX, mouseY, 30)
}
```
:::
`````

---

## 54. Corresponding High-level Semantic Tree

```text
document
├ heading(level=1)
├ paragraph
├ callout(type=warning)
├ sticky(tone=yellow)
├ toggle
│ └ list
├ tabs
│ ├ tab(SAC)
│ └ tab(PPO)
├ columns(count=2)
│ ├ column
│ │ ├ heading
│ │ └ paragraph
│ └ column
│   ├ heading
│   └ paragraph
├ image(asset://...)
└ runtime(p5)
```

---

# Conformance

## 55. Parser Conformance

A conforming parser MUST：

- parse GFM baseline
- parse generic directives
- produce MDAST
- perform semantic transform
- preserve unknown directive information
- return diagnostics without process crash for malformed input
- canonical valid documents MUST include `glyphquire-spec`
- expose the positive integer spec version to the migration layer
- reject unsupported future versions without destructive guessing
- report database/Markdown version mismatch

---

## 56. Serializer Conformance

A conforming serializer MUST：

- serialize all supported built-in nodes
- preserve semantic AST round-trip
- handle nested directive fences
- retain unknown directives when possible
- preserve `asset://` logical references
- ensure canonical serialization emits or retains `glyphquire-spec`
- never depend on Vue/DOM

---

## 57. Milkdown Plugin Conformance

Each semantic visual block MUST have tests for：

```text
Markdown → Milkdown node
Milkdown node → Markdown
Markdown → Milkdown → Markdown → Semantic AST
```

---

## 58. Custom Block Conformance

User-defined block definition MUST pass：

- name validation
- schema validation
- reserved-name validation
- renderer-preset validation
- capability validation
- round-trip fixture

before activation。

---

# Testing Fixtures

## 59. Required Fixture Categories

Canonical valid documents MUST include `glyphquire-spec`。Version handling MUST include：

```text
missing-version-marker
invalid-version-non-positive
invalid-version-non-integer
unsupported-future-version
metadata-version-mismatch
```

Every built-in directive MUST include：

```text
valid-minimal.md
valid-full.md
valid-nested.md
invalid-required-attribute.md
invalid-attribute-value.md
unknown-attribute.md
roundtrip.md
migration-vN-vN+1.md
```

The golden fixture harness MAY also read `expected.diagnostics.json`, an
ordered list of diagnostic codes. Rejected fixtures MUST assert a null
document, exact source retention, and no canonical `expected.md`; accepted
fixtures continue to assert their normalized AST and canonical Markdown.

Parent/child blocks additionally：

```text
invalid-parent.md
invalid-child.md
```

---

## 60. Property Tests

Useful properties：

```text
parse never crashes on arbitrary UTF-8 input
serialize(parse(valid)) preserves semantics
migrate(v1→v1) is identity
migrate result is parseable
unknown directives survive parse/serialize
```

---

# Decisions

## 61. ADR Summary

```text
ADR-01  Generic directives (unified/remark-directive)  Accepted
ADR-02  MDAST + Notebook Semantic AST                 Accepted
ADR-03  Milkdown ↔ MDAST                              Accepted
ADR-04  Graphile Worker                               Accepted
ADR-05  PostgreSQL FTS + pg_trgm hybrid search        Accepted
ADR-06  asset:// logical URI                          Accepted
ADR-07  Built-ins + declarative custom blocks         Accepted
ADR-08  Design Tokens + approved variants             Accepted
ADR-09  Network deny by default + explicit allowlist  Accepted
ADR-10  SPA-first public rendering                    Accepted
```

Only ADR-01/02/03/06/07/08/09 directly shape this Markdown specification; the others are recorded here for cross-document consistency。

---

# v0.1 Explicit Non-features

## 62. Not in v0.1

- arbitrary HTML
- MDX/JSX
- arbitrary Vue components in Markdown
- arbitrary CSS
- arbitrary JS in main app origin
- unrestricted sandbox networking
- YAML metadata inside every directive
- JSON blob syntax as primary custom-block syntax
- inline executable expressions
- dynamic database queries from Markdown
- server-side plugin code
- macro language
- template evaluation
- document-level scripting

---

# Future Syntax Candidates

## 63. Later Features

Potential future directives，暫不保證語法：

```text
mermaid
chart
timeline
quiz
flashcard
gallery
kanban
embed
video
audio
map
diagram
spoiler
steps
comparison
```

Potential future inline directives：

```md
:badge[Beta]{type="warning"}
:mention[User]{id="..."}
:icon[gpu]
```

Potential future leaf directive：

```md
::divider{style="dots"}
```

在正式加入前，每種 syntax 都必須經 ADR + round-trip fixture。

---

# Implementation Priority

## 64. First Parser Slice

第一個 vertical slice 只實作：

```text
GFM
callout
toggle
asset:// image
```

Acceptance flow：

```text
Markdown
→ MDAST
→ Semantic AST
→ validation
→ renderer
→ Semantic AST
→ MDAST
→ Markdown
```

通過 round-trip 後才加入：

```text
sticky
tabs
columns
```

最後再加入：

```text
p5
canvas
user custom blocks
```

如此可以先驗證 grammar/AST/serializer contract，再增加 editor/runtime complexity。

---

## 65. Source of Truth Hierarchy

若文件間發生規格衝突：

1. `MARKDOWN_SPEC.md` 決定 Markdown grammar、AST mapping、serialization。
2. `SPEC.md` 決定 application/system architecture。
3. Component implementation 不得自行發明與兩份規格衝突的 syntax。

任何 breaking grammar change MUST 先更新 `MARKDOWN_SPEC.md` 並提供 migration。
