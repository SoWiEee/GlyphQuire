# SPEC.md — Extensible Markdown Notes Platform

> Status: Draft v0.3 — Production Readiness Contract added
> Deployment target: Officially hosted multi-tenant SaaS; Cloudflare-ready
> Primary language: TypeScript  
> Last updated: 2026-08-19

## 1. Purpose

本文件定義一套以 Markdown 為 canonical document format 的可擴充網頁筆記平台。產品目標是讓一般使用者以接近 Obsidian 的 Markdown 與少量延伸語法建立具有高度視覺風格、互動效果與可組合元件的筆記，同時讓進階使用者可在受控邊界內建立自訂 block、theme 與互動 runtime。

P0 production target 為官方託管的多租戶 SaaS。典型工作負載為一位活躍使用者的個人筆記本，突發上限為五位同時使用者。架構不得綁死 Node.js-only API、單一 object storage、單一 job queue 或單一部署供應商。Docker Compose 為支援的本地開發與全端預覽路徑。Self-hosted production support 為 P1，非 P0 release promise。後續預計可將 frontend/API/worker 等服務遷移至 Cloudflare Workers 生態，並以 Hyperdrive 連接 PostgreSQL、R2 作為 object storage、Cloudflare Queues 作為背景任務佇列。Cloudflare portability 維持為架構約束，非 P0 必要 runtime。

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 2. Product Goals

### 2.1 核心目標

1. Markdown 必須是文件的 canonical source of truth。
2. 使用者可在 Visual Mode 與 Source Mode 間切換。
3. Visual Mode 使用 Milkdown。
4. Source Mode 使用 CodeMirror 6。
5. 同一份 Markdown 必須能穩定完成：
   - parse
   - validate
   - render
   - edit
   - serialize
   - migrate
   - export
6. 支援自訂 semantic blocks，例如：
   - callout
   - sticky note
   - toggle
   - tabs
   - columns
   - timeline
   - interactive sketch
7. Theme 與文件內容解耦。
8. 進階使用者可定義受控的 custom components / themes。
9. JavaScript、p5.js、Canvas 等互動內容必須執行於隔離 runtime，不得直接執行於主應用程式 origin。
10. P0 production 為官方託管的多租戶 SaaS；核心 domain/service layer 應可搬遷到 Cloudflare Workers。Self-hosted production support 為 P1。

### 2.2 非目標

v1 不包含以下項目：

- Google Docs 等級的多人即時共同編輯
- CRDT/offline conflict resolution
- 完整 plugin marketplace
- arbitrary server-side plugin execution
- arbitrary unsandboxed JavaScript
- 完整 Notion-style database
- AI agent/editor
- mobile native app
- end-to-end encrypted collaboration
- enterprise SSO
- semantic/vector search

以上功能可列入後期 roadmap，但不得要求 v1 的核心資料模型大幅重寫。

---

## 3. Architectural Principles

### 3.1 Markdown is canonical

資料庫中的 `notes.content_markdown` 為唯一 authoritative document state。

以下皆屬 derived or temporary representation：

- Milkdown / ProseMirror document
- CodeMirror state
- AST
- rendered HTML
- search index text
- export output

不得同時將 Markdown、ProseMirror JSON、HTML 與自訂 block JSON 視為多份 canonical state。

### 3.2 Semantic over visual syntax

自訂語法描述內容語意，不描述任意 CSS implementation。

建議：

```md
:::callout
type: warning
title: 注意
---

GPU memory is shared.
:::
```

避免：

```md
:::callout
padding: 14px
border: 1px solid red
transform: translateY(-2px)
:::
```

視覺呈現由 Component Registry、Theme Engine 與 Design Tokens 決定。

### 3.3 Ports and adapters

以下外部系統必須透過介面抽象：

- Object Storage
- Job Queue
- Email provider
- Runtime sandbox
- Search implementation
- telemetry/error reporting

Local 與 Cloudflare deployment 只替換 adapter，不改寫 domain logic。

### 3.4 Client-only editor

Milkdown 與 CodeMirror 只在 browser/client lifecycle 建立。

不得讓核心 parser、serializer、validator 依賴 DOM，使 Document Engine 可在 API、worker、test runner 中執行。

### 3.5 Secure by default

任何 user-generated executable code、custom CSS、plugin manifest、external embed 均視為不可信輸入。

---

## 4. Technology Stack

### 4.1 Frontend

- TypeScript
- Vue 3
- Vite
- Vue Router
- Pinia
- Tailwind CSS
- CSS Custom Properties
- Milkdown
- CodeMirror 6

Nuxt 不列為 v1 必要依賴。產品核心為登入後 SPA/editor，SSR 對主要編輯流程沒有必要性。未來若公開頁面需要 SEO，可評估 static rendering、pre-render 或獨立 public rendering layer。

### 4.2 Backend

- TypeScript
- Hono
- Hono RPC
- Better Auth
- Zod
- Drizzle ORM
- PostgreSQL

### 4.3 Storage

Local:

- PostgreSQL
- S3-compatible object storage
- 預設 MinIO

Future Cloudflare:

- PostgreSQL 維持既有資料庫
- Cloudflare Hyperdrive 作為 Workers 與 PostgreSQL 之連線層
- Cloudflare R2 作為 Object Storage

### 4.4 Background Processing

Local:

- Graphile Worker
- PostgreSQL-backed queue
- dedicated TypeScript worker process
- at-least-once delivery semantics
- idempotent task handlers
- retry with exponential backoff

Future Cloudflare:

- Cloudflare Queues
- Queue consumer Workers
- preserve the same versioned job envelope and idempotency contract

所有 producer/consumer business payload 必須使用版本化 schema。

### 4.5 Sandbox

- cross-origin iframe
- `postMessage`
- p5.js runtime
- Canvas runtime
- Web Worker where appropriate
- strict runtime protocol
- CSP
- resource/time limits

---

## 5. Monorepo Structure

建議使用 `pnpm workspace`：

```text
/
├─ apps/
│  ├─ web/                  # Vue 3 SPA
│  ├─ api/                  # Hono API
│  ├─ worker/               # Local background worker
│  └─ sandbox/              # Isolated interactive runtime
│
├─ packages/
│  ├─ document-engine/      # parser / AST / validator / serializer
│  ├─ markdown-spec/        # syntax definitions + schema versions
│  ├─ components/           # built-in semantic components
│  ├─ component-sdk/        # custom block interfaces
│  ├─ theme-engine/         # design tokens / theme resolver
│  ├─ theme-sdk/            # user theme schema
│  ├─ runtime-protocol/     # postMessage contracts
│  ├─ api-contract/         # Hono RPC/shared DTO
│  ├─ auth/                 # shared auth helpers
│  ├─ database/             # Drizzle schema + migrations
│  ├─ storage/              # StoragePort + adapters
│  ├─ queue/                # QueuePort + adapters
│  ├─ telemetry/            # logging / metrics contracts
│  └─ shared/               # generic shared utilities
│
├─ infra/
│  ├─ docker/
│  ├─ caddy/
│  └─ cloudflare/
│
├─ tests/
├─ docker-compose.yml
├─ pnpm-workspace.yaml
└─ SPEC.md
```

禁止 `apps/web` 直接 import `apps/api` implementation。共享型別只能從 `packages/*` 引用。

---

## 6. Runtime Architecture

```text
Browser
┌────────────────────────────────────────────────┐
│ Vue SPA                                        │
│                                                │
│ ┌──────────────┐  ┌────────────────────────┐  │
│ │ Milkdown     │  │ CodeMirror 6           │  │
│ │ Visual Mode  │  │ Source Mode            │  │
│ └──────┬───────┘  └───────────┬────────────┘  │
│        └───────────┬───────────┘               │
│                    │ Markdown                  │
│              Document Engine                   │
│                    │                           │
│             Component Renderer                │
│                    │                           │
│        ┌───────────┴──────────────┐            │
│        │ sandboxed iframe         │            │
│        │ separate origin          │            │
│        └──────────────────────────┘            │
└───────────────────┬────────────────────────────┘
                    │ /api
                    ▼
┌────────────────────────────────────────────────┐
│ Hono API                                       │
│ Auth / Notes / Assets / Search / Versions      │
└───────────────┬──────────────────────┬─────────┘
                │                      │
                ▼                      ▼
          PostgreSQL              Object Storage
                │
                ▼
             Job Queue
                │
                ▼
              Worker
```

---

## 7. Document Engine

`packages/document-engine` 為產品最核心且不得依賴 Vue、Milkdown、CodeMirror、Tailwind、Hono 的 pure TypeScript package。

實作基礎為 unified/remark 生態：parse 使用 `unified` + `remark-parse` + `remark-gfm` + `remark-directive` + `remark-frontmatter` 產生 MDAST；serialize 使用 `mdast-util-to-markdown` 及對應 GFM/directive/frontmatter extensions。Grammar 細節與 conformance：見 `MARKDOWN_SPEC.md` §4、§34。

### 7.1 Responsibilities

- parse Markdown
- parse custom syntax
- construct AST
- semantic validation
- syntax diagnostics
- serialize AST → Markdown
- AST transformation
- document migration
- plain-text extraction
- search-text extraction
- export preparation

### 7.2 Required API

```ts
export interface DocumentEngine {
  parse(markdown: string): ParseResult;
  importLegacy(markdown: string, assumedVersion: number): ParseResult;
  validate(document: DocumentNode): ValidationResult;
  serialize(document: DocumentNode): string;
  migrate(markdown: string, from: number, to: number): MigrationResult;
  extractText(document: DocumentNode): string;
}
```

`parse` MUST read `glyphquire-spec` from canonical Markdown。Only the explicitly named `importLegacy` accepts a caller-selected version；its result and diagnostics MUST preserve the original input。Format rules：see `MARKDOWN_SPEC.md` §47。

### 7.3 Round-trip invariant

對合法 document：

```text
markdown
→ parse
→ AST
→ serialize
→ markdown'
```

必須保證語意等價。

測試要求：

```ts
normalize(parse(serialize(parse(markdown)))) === normalize(parse(markdown));
```

格式化造成的 whitespace 差異可接受，但不得遺失 semantic data。

---

## 8. Markdown Specification

建立獨立版本：

```text
Notebook Markdown Spec v0.1
```

每份 note 儲存：

```ts
schemaVersion: number;
```

### 8.1 Base syntax

優先採用：

- CommonMark-compatible Markdown
- GFM features where supported
- headings
- blockquote
- list
- task list
- table
- fenced code
- links
- images
- inline code
- emphasis
- horizontal rule
- math extension

### 8.2 Custom block syntax

Custom block grammar 採 generic directive syntax，實作基礎為 `remark-directive` / `mdast-util-directive`。

```md
:::callout{type="warning" title="注意"}
GPU memory is shared.
:::
```

```md
:::toggle{title="詳細內容"}
Content
:::
```

Nested container 使用較長的 colon fence：

```md
::::columns{count="2"}

:::callout{type="info"}
Left
:::

:::callout{type="warning"}
Right
:::

::::
```

完整 grammar、escaping、unknown directive、serialization 與 Semantic AST mapping 定義於 `MARKDOWN_SPEC.md`。

### 8.3 Executable code blocks

````md
```p5
function setup() {
  createCanvas(600, 400)
}
```
````

````

metadata 必須由 parser 轉換成受控 schema，不允許任意 HTML attributes 注入。

### 8.4 HTML

v1 預設不允許 raw HTML。

未來若開放，必須經由獨立 sanitizer policy。

---

## 9. AST

### 9.1 Generic node

```ts
type NodeId = string;

interface BaseNode {
  id?: NodeId;
  type: string;
}

interface DocumentNode extends BaseNode {
  type: "document";
  version: number;
  children: BlockNode[];
}
````

### 9.2 Custom node

```ts
interface CalloutNode extends BaseNode {
  type: "callout";
  version: 1;
  props: {
    variant: "info" | "warning" | "danger" | "success";
    title?: string;
    icon?: string;
  };
  children: BlockNode[];
}
```

Markdown parser 先建立 MDAST，再由 `packages/document-engine` 將支援的 MDAST/directive nodes 轉換成 Notebook Semantic AST。Milkdown 僅與 Remark/MDAST transformation pipeline 整合，不直接依賴 Notebook Semantic AST。

AST node props 必須使用 schema validator 驗證。

未知 node：

- editor 顯示 unsupported block
- serializer 保留原始內容，如可安全 round-trip
- renderer 不執行未知程式碼

---

## 10. Editor Architecture

### 10.1 Modes

#### Visual Mode

Milkdown 提供：

- WYSIWYG Markdown editing
- rich text editing
- block controls
- slash command
- component node views
- custom block rendering

#### Source Mode

CodeMirror 6 提供：

- Markdown source
- syntax highlighting
- line numbers
- lint diagnostics
- autocomplete
- custom block completion
- schema diagnostics
- formatting
- future diff viewer

### 10.2 Synchronization

切換模式流程：

```text
Visual Mode
→ serialize Markdown
→ validate
→ Source Mode
```

```text
Source Mode
→ parse + validate
→ update visual document
→ Visual Mode
```

禁止在兩個 editor instance 同時維持獨立 authoritative state。

### 10.3 Dirty state

Frontend 至少追蹤：

```ts
interface EditorState {
  noteId: string;
  baseVersion: number;
  markdown: string;
  dirty: boolean;
  lastSavedAt?: string;
  saveState: "idle" | "saving" | "saved" | "error";
}
```

Conflict recovery：

- `409 REVISION_CONFLICT` MUST NOT overwrite server content。
- Client MUST retain the unsent local draft across browser reload or crash。
- UI MUST support comparison、copying 或 manual merge before resubmission。
- Automatic three-way merge、CRDT 與 real-time collaboration are outside P0。

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 11. Component System

### 11.1 Component Registry

所有 built-in/custom blocks 透過 registry 註冊。

```ts
interface ComponentDefinition<TProps> {
  name: string;
  version: number;
  schema: unknown;
  render: unknown;
  capabilities: ComponentCapability[];
}
```

### 11.2 Built-in v1 components

- heading
- paragraph
- quote
- code
- image
- callout
- sticky-note
- toggle
- tabs
- columns
- divider
- math
- p5
- canvas

### 11.3 Custom Block API

Detailed requirement: see `MARKDOWN_SPEC.md` §29 for definition lifecycle and unsupported placeholders。Detailed requirement: see §16 for workspace-scoped resolution。

v1 提供 built-in block presets，並允許使用者建立 declarative custom blocks。

Built-in preset 與 user-defined block 共用相同 Component Registry contract。使用者可以自訂新的 block 名稱與受控 schema，但不可把任意 Vue/JavaScript 注入 main application runtime。

允許：

- custom block name
- props schema
- nested content policy
- icon
- component preset / variant
- design-token mapping
- declarative composition of approved primitives
- capabilities limited to `static` and `interactive-ui`

不允許：

- 在 main application origin 執行 arbitrary JS
- 直接 import server package
- 任意 filesystem access
- 任意 network credentials
- mutation application global state
- sandbox runtime request（需另行核准 runtime contract；不屬於目前 Custom Block API）

---

### 11.4 Custom Block persistence contract

Custom Block definitions are workspace-scoped records with a mutable draft and
immutable published versions. Owners and editors may create, update drafts,
publish, or remove drafts; viewers may list definitions but cannot mutate them.
Every mutation carries a canonical `operationId` and `baseRevision` compare-and-
swap token. A stale revision returns `REVISION_CONFLICT`; a reused operation
identifier with a different request returns `OPERATION_REUSED`.

The first-party endpoints are:

```text
GET    /api/v1/workspaces/:workspaceId/custom-blocks
POST   /api/v1/workspaces/:workspaceId/custom-blocks
PUT    /api/v1/custom-blocks/:id/draft
POST   /api/v1/custom-blocks/:id/publish
DELETE /api/v1/custom-blocks/:id       # draft only
```

Definitions are validated by the shared `theme-sdk` schema. The schema limits
property count, string/enum sizes, icon names, renderer presets, token paths,
and capabilities before persistence. Published versions are never edited in
place; a new positive version must be drafted and published instead.

## 12. Plugin Manifest

Plugin manifest 必須是 declarative JSON-compatible data。

```ts
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  blocks?: BlockManifest[];
  themes?: ThemeManifest[];
  runtimes?: RuntimeManifest[];
  permissions?: PluginPermission[];
}
```

### 12.1 Permission examples

- `runtime:p5`
- `runtime:canvas`
- `network:none`
- `network:allow-listed`
- `asset:read`
- `asset:write`

v1 不開放 third-party server plugin。

---

## 13. Theme Engine

Theme 必須由 semantic design tokens 驅動。

### 13.1 Global tokens

```ts
interface ThemeTokens {
  color: {
    background: string;
    foreground: string;
    muted: string;
    accent: string;
    border: string;
  };
  typography: {
    bodyFont: string;
    headingFont: string;
    monoFont: string;
  };
  radius: {
    sm: string;
    md: string;
    lg: string;
  };
  spacing: Record<string, string>;
}
```

### 13.2 Component variants

```ts
interface ThemeComponents {
  heading?: {
    decoration?: "none" | "sparkle" | "line";
  };
  quote?: {
    variant?: "plain" | "sticky" | "paper";
  };
  callout?: {
    variant?: "solid" | "glass" | "outline";
    animation?: "none" | "glow" | "lift";
  };
}
```

### 13.3 User customization

v1：

- design token override
- predefined component variants
- uploaded theme manifest
- preview before activation

v1 不允許 unrestricted global CSS。

### 13.4 Persisted user preferences

Theme mode and bounded token/variant overrides are persisted for the
authenticated user, independent of the active workspace or device. The
preference API is intentionally user-scoped: clients MUST NOT send a user ID or
workspace ID. `themeId` may reference only a built-in system theme; workspace
themes can be copied into bounded overrides but are not global preference
identities. Writes use `baseRevision` compare-and-swap and return
`REVISION_CONFLICT` when stale.

```text
GET /api/v1/me/preferences/theme
PUT /api/v1/me/preferences/theme
```

The web client applies the server result through `ThemeProvider` and keeps
failed saves as an unapplied draft. No theme preference is stored in
`localStorage`, URL parameters, or document Markdown.

### 13.5 Icon contract

Persisted icon references use a finite Lucide name allowlist shared by
`theme-sdk`, API validation, and the web `GqIcon` wrapper. Unknown names are
rejected before persistence. Decorative icons are `aria-hidden`; meaningful
icons require an accessible label. Components MUST NOT render arbitrary icon
component names or raw SVG supplied by a user.

後期可加入 restricted CSS sandbox。

### 13.6 Visual direction (P1)

GlyphQuire 使用 Paper Canvas 作為 editor 的視覺基準：內容區以留白、紙張表面與清楚的排版層級為主，只有選取中或可互動的區塊才顯示額外 chrome。Built-in block 不得依賴裝飾性漸層、玻璃擬態、閃爍動畫或隨機旋轉來傳達功能。

Built-in custom block 的呈現規則：

- callout 使用語意色帶、icon 與 optional title；顏色不能是唯一的狀態提示。
- sticky note 預設使用低對比紙張色與清楚標籤；高對比變體不得取代文字或狀態語意。
- toggle 使用 disclosure header、chevron 與 `aria-expanded`，內容可明確展開或收合。
- tabs 使用 `tablist`、`tab`、`tabpanel` 語意，active tab 使用單一底線或同等低干擾指示。
- columns 使用 tokenized gap；狹窄 editor pane 必須堆疊，不得產生水平溢出。
- runtime 顯示 user-facing 的 preview、Run/Stop/Reset、loading 與 error 狀態；一般 UI 不顯示內部 capability 或 debug 名稱。
- unknown/invalid block 顯示可恢復的 unsupported 狀態，原始來源放在明確的進階檢視中。

Visual Mode 的 block controls 必須使用友善名稱並與 authored content 分離。Theme Editor 的 token 與 approved variant 變更必須即時反映在 editor，且所有狀態需維持 WCAG 2.2 AA 對比與可見 focus ring。P1 驗收以 Chrome 桌面畫面矩陣、鍵盤操作及 light/dark theme 人工檢視為主，不建立大量視覺 snapshot 測試。

---

## 14. Interactive Runtime

### 14.1 Security boundary

主站與 sandbox 必須是不同 origin。

Local example:

```text
http://app.localhost
http://sandbox.localhost
```

或以不同 port 形成不同 origin。

Cloud example:

```text
https://app.example.com
https://sandbox.exampleusercontent.com
```

Sandbox 不得取得：

- application cookies
- authentication token
- localStorage
- sessionStorage
- Vue application state
- database credentials
- internal API secrets

### 14.2 iframe

原則上：

```html
<iframe sandbox="allow-scripts"></iframe>
```

不預設加入 `allow-same-origin`。

### 14.3 Protocol

所有主頁與 runtime 互動使用版本化 message protocol。

```ts
type RuntimeMessage =
  | { v: 1; type: "runtime:init"; payload: RuntimeInit }
  | { v: 1; type: "runtime:execute"; payload: RuntimeExecute }
  | { v: 1; type: "runtime:resize"; payload: { height: number } }
  | { v: 1; type: "runtime:error"; payload: RuntimeError }
  | { v: 1; type: "runtime:stop" };
```

Receiver 必須：

1. 驗證 `event.origin`
2. 驗證 message schema
3. 驗證 runtime instance ID
4. reject unknown message
5. rate-limit message flood

禁止使用 `postMessage(message, "*")` 傳送敏感資訊。

### 14.4 Runtime v1

#### p5.js

允許：

- Canvas rendering
- pointer/keyboard interaction
- animation loop

#### Canvas

提供受控 bootstrap context。

### 14.5 Network policy

Sandbox network 預設拒絕。

v1 protocol 預留 explicit allowlist capability：

````md
```p5 {network=["https://api.example.com"]}
...
```
````

````

實際執行前由 Runtime Manager 驗證 allowlist。MVP 可先實作完全禁網，再啟用 allowlist；不得提供 unrestricted Internet access。

### 14.6 Resource control

v1 至少支援：

- execution timeout
- reset
- stop
- maximum iframe count per page
- maximum runtime message rate
- maximum code size
- runtime crash recovery

Web Worker 可用於：

- parser-heavy computation
- expensive layout preparation
- user computation that does not require DOM

---

## 15. Authentication

Better Auth 作為 authentication provider。

v1 支援：

- email/password
- session management
- logout all sessions
- password reset
- optional social login

Detailed requirement: see §32 Security Requirements。

---

## 16. Authorization

Authentication 與 authorization 分離。

### 16.1 Roles

Workspace：

```text
owner
editor
viewer
````

### 16.2 Note visibility

```text
private
workspace
unlisted
public
```

### 16.3 Policy

Authorization is deny-by-default。所有 read、list、search、mutation、restore、asset resolution、share access 與 worker execution MUST perform server-side authorization。

禁止依賴 frontend hidden buttons 作為安全控制。

API service 使用：

```ts
authorize(actor, action, resource);
```

作為統一 policy entry point。

Tenant invariants：

- Every note、asset、theme、share link、search record 與 job MUST belong to exactly one workspace。
- Every server and worker operation MUST derive workspace scope from trusted server-side context and apply it to the resource query。
- Resource owner MUST be a current workspace member；ownership MUST be transferred before that member leaves。
- Cross-workspace asset and Custom Block references MUST be rejected。

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 17. Persistence Model

### 17.1 Core tables

```text
users
sessions
accounts
verification

workspaces
workspace_members

notes
note_versions

assets

share_links

themes
user_themes

jobs

audit_logs
```

### 17.2 Notes

Detailed requirement: see §16 for workspace ownership and tenant isolation。

```ts
interface NoteRow {
  id: string;
  workspaceId: string;
  ownerId: string;

  title: string;
  slug: string | null;

  contentMarkdown: string;
  schemaVersion: number;

  visibility: "private" | "workspace" | "unlisted" | "public";

  revision: number;

  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
```

### 17.3 Optimistic concurrency

Detailed requirement: see §10.3 for client conflict recovery、§18 for transactional autosave、and §19 for history semantics。

更新：

```http
PUT /notes/:id
```

request：

```json
{
  "baseRevision": 41,
  "contentMarkdown": "..."
}
```

若目前 database revision ≠ `baseRevision`：

```http
409 Conflict
```

不得默默覆蓋。

---

## 18. Autosave

Autosave is the sole authority for transactional note persistence。

### 18.1 Client behavior

建議：

- debounce 1–2 seconds
- network reconnect retry
- keep last unsaved local draft
- visible save state

### 18.2 Server behavior

每次 autosave MUST perform the following in one PostgreSQL transaction：

1. authorization
2. validate document size
3. validate revision
4. update current note
5. increment revision
6. selectively create version snapshot
7. enqueue search-index job when needed

Revision validation MUST use compare-and-swap。Durable Graphile Worker enqueue commits or rolls back with the note update and optional snapshot。

```ts
type NoteOperationIdentity = {
  noteId: string;
  revision: number;
  operation: string;
};
```

Handler MUST be idempotent by `NoteOperationIdentity`。A job for an older revision MUST NOT replace derived state for a newer revision。

### 18.3 Version snapshot policy

避免每次按鍵建立版本。

snapshot trigger：

- significant content delta
- elapsed time threshold
- manual checkpoint
- before destructive migration
- before restore
- before major import

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 19. Version History

Version History is the sole authority for import、restore 與 document migration revision semantics。

`note_versions`：

```text
id
note_id
revision
schema_version
content_markdown
author_id
reason
created_at
```

v1 支援：

- list history
- preview
- restore
- manual checkpoint

後期：

- visual diff
- named versions
- branch/fork

Import、restore 與 document migration MUST submit `baseRevision`。A mismatch returns `409 REVISION_CONFLICT`。

Successful operation MUST：

- create a new monotonically increasing revision
- record actor、timestamp 與 reason
- preserve the previous revision rather than rewind or overwrite history

Failure MUST preserve the original Markdown。Marker validation and legacy import：see `MARKDOWN_SPEC.md` §47。Detailed requirement: see §10.3 for client conflict recovery。

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 20. Full-text Search

Full-text Search is the sole authority for index consistency and recovery。Detailed requirement: see §16 for tenant isolation。

v1 採 Hybrid Search。

```text
English / tokenized text:
PostgreSQL Full Text Search (`tsvector` / `tsquery`)

CJK / fuzzy matching:
`pg_trgm`

Exact / fallback:
normalized match / constrained `ILIKE`
```

搜尋資料由：

```text
Markdown
→ MDAST
→ Notebook Semantic AST
→ extract searchable text
→ normalized search document
```

產生。

不要直接將 raw custom syntax 當完整 searchable content。

Index 至少包含：

- title
- headings
- body text
- tags

英文/可斷詞欄位使用 `tsvector` + GIN index；CJK 與 fuzzy query 使用 `pg_trgm` 對 normalized text 建立適合的 GIN/GiST index。實際 ranking 由 Search Service 統一整合，不讓 frontend 知道 backend search strategy。

搜尋介面透過 `SearchPort`：

```ts
interface SearchPort {
  indexNote(note: SearchableNote): Promise<void>;
  removeNote(noteId: string): Promise<void>;
  search(query: SearchQuery): Promise<SearchResult[]>;
}
```

未來可替換為 dedicated search backend，而不改變 API/domain contract。

Consistency contract：

- Saved content and revision history are immediately authoritative。
- Under the approved P0 benchmark environment and workload, every successfully saved revision MUST become searchable within 60 seconds；outside that profile this is an engineering target rather than an external SLA。
- Query-time authorization MUST exclude unauthorized、deleted 與 cross-workspace content。
- Failed indexing MUST retry and then enter dead-letter state with an operator alert。
- Operator MUST be able to rebuild one note or one workspace。

Production release priority and evidence: see §49 Production Readiness Contract。

## 21. Asset Manager

Detailed requirement: see §16 for workspace authorization。Detailed requirement: see §33 for retention and deletion lifecycle。

### 21.1 Supported assets

v1：

- image
- attachment
- generated thumbnail

### 21.2 Database metadata

```text
assets
├ id
├ workspace_id
├ owner_id
├ object_key
├ original_name
├ mime_type
├ size
├ sha256
├ created_at
└ deleted_at
```

### 21.3 Canonical asset reference

Markdown canonical content 不儲存 MinIO、R2、CDN 或 presigned URL。

使用 logical URI：

```md
![Architecture](asset://01JABCDEF1234567890)
```

`asset://<asset-id>` 由 Asset Resolver 根據 authorization 與 deployment adapter 轉換成可讀取 URL。

Private asset 可以 resolve 為短效 signed/presigned URL；public asset 可 resolve 為 cacheable public URL。

此規則避免 object-storage provider、bucket 或 domain 變更污染 canonical Markdown。

### 21.4 Storage key

不可直接信任原始檔名。

例如：

```text
workspace/{workspaceId}/assets/{assetId}/original
```

### 21.5 Upload

至少驗證：

- authenticated user
- authorization
- declared size
- actual size
- MIME allowlist
- quota
- filename normalization

SVG 預設視為 active content，不直接 inline 至主 application DOM。

### 21.6 Storage abstraction

```ts
interface ObjectStoragePort {
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<ReadableStream>;
  delete(key: string): Promise<void>;
  createDownloadUrl?(key: string): Promise<string>;
}
```

Adapters：

```text
MinIOAdapter
R2Adapter
```

---

## 22. Import / Export

Detailed requirement: see §19 for `baseRevision`、conflict and history semantics。Detailed requirement: see §33 for export and deletion lifecycle。

### 22.1 Import v1

- Markdown
- ZIP containing Markdown + assets

Import 必須：

- validate path traversal
- limit archive size
- limit file count
- validate custom syntax
- preserve unsupported syntax when possible
- require `baseRevision` when importing into an existing note

### 22.2 Export v1

- Markdown
- Markdown + assets ZIP
- rendered HTML

後期：

- PDF
- static site
- Obsidian vault
- EPUB

---

## 23. Share Links

Share link 儲存 random opaque token hash。

支援：

- read-only
- optional expiration
- revoke
- optional password later

不得將 sequential database ID 作為 access secret。

---

## 24. API Design

API Design is the sole authority for the first-party HTTP contract。

Base：

```text
/api/v1
```

### 24.1 Example endpoints

```text
GET    /api/v1/me

GET    /api/v1/workspaces
POST   /api/v1/workspaces

GET    /api/v1/notes
POST   /api/v1/notes
GET    /api/v1/notes/:id
PUT    /api/v1/notes/:id
DELETE /api/v1/notes/:id

GET    /api/v1/notes/:id/versions
POST   /api/v1/notes/:id/restore/:revision

POST   /api/v1/assets
GET    /api/v1/assets/:id
DELETE /api/v1/assets/:id

GET    /api/v1/search

POST   /api/v1/share-links
DELETE /api/v1/share-links/:id

GET    /api/v1/themes
POST   /api/v1/themes

GET    /api/v1/me/preferences/theme
PUT    /api/v1/me/preferences/theme

GET    /api/v1/workspaces/:workspaceId/custom-blocks
POST   /api/v1/workspaces/:workspaceId/custom-blocks
PUT    /api/v1/custom-blocks/:id/draft
POST   /api/v1/custom-blocks/:id/publish
DELETE /api/v1/custom-blocks/:id
```

Hono RPC 作為 first-party frontend type-safe client。

P0 only commits to the first-party `/api/v1` interface。Every request and response MUST have a shared schema。

- List and search operations MUST use cursor pagination and deterministic ordering。
- Retriable create、upload 與 export operations MUST accept idempotency keys。
- Mutation MUST use revision or equivalent conditional request。
- Error codes MUST remain backward compatible within `/api/v1`。
- Breaking contract requires a new API version or an explicit migration。

Public API credentials、third-party tokens 與 long-term SDK compatibility are P1。Hono RPC internal types are not a permanent public contract。

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 25. Input Validation

Detailed requirement: see §24 for the first-party API contract。

API boundary 與 runtime message boundary 均使用 schema validation。

Zod schemas 建議分為：

```text
packages/api-contract
packages/runtime-protocol
packages/markdown-spec
packages/theme-sdk
```

不得：

```ts
const body = (await c.req.json()) as SomeType;
```

直接信任 client type assertion。

---

## 26. Error Model

Detailed requirement: see §24 for version and compatibility rules。

API error：

```ts
interface ApiError {
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
}
```

常見 code：

```text
VALIDATION_ERROR
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
REVISION_CONFLICT
RATE_LIMITED
DOCUMENT_PARSE_ERROR
ASSET_TOO_LARGE
UNSUPPORTED_SCHEMA_VERSION
INTERNAL_ERROR
```

production response 不回傳 stack trace。

---

## 27. Background Jobs

Detailed requirement: see §16 for tenant isolation、§18 for note-operation identity and transactional enqueue、and §20 for search freshness and rebuild behavior。

### 27.1 Jobs v1

- update search index
- generate image metadata/thumbnail
- remove orphaned assets
- export document
- cleanup expired share links
- version retention cleanup
- backup verification

### 27.2 Job envelope

```ts
interface JobEnvelope<T> {
  id: string;
  type: string;
  version: number;
  attempts: number;
  createdAt: string;
  payload: T;
}
```

### 27.3 Requirements

- at-least-once safe
- handler idempotency
- retry
- exponential backoff
- dead-letter handling
- structured failure logs

Consumer 不得假設 exactly-once delivery。

---

## 28. Logging

Detailed requirement: see §30 for operational monitoring。Detailed requirement: see §33 for log retention and prohibited content。

使用 structured JSON logging。

必要欄位：

```text
timestamp
level
service
requestId
userId?
workspaceId?
route?
durationMs?
errorCode?
```

禁止 log：

- password
- session token
- auth cookie
- private document full text
- runtime user code by default
- object storage secret

---

## 29. Error Tracking

Detailed requirement: see §30 for operational monitoring and alert delivery。

建立 `ErrorReporter` abstraction。

Local：

- console / structured log

Production：

- 可接 Sentry 或其他 provider

報告內容需經敏感資料 scrub。

---

## 30. Operational Monitoring

Operational Monitoring is the sole authority for production probes、alerts and runbooks。

### Metrics

v1 至少：

### HTTP

- request count
- error count
- latency
- status distribution

### Editor/API

- autosave success/failure
- parse failures
- document migration failures
- revision conflicts

### Queue

- queue depth
- processing latency
- retries
- dead letters

### Sandbox

- runtime execution
- runtime error
- timeout
- message rejection

### Health、readiness and alert routing

| ID              | Condition             | Threshold                                                           | Required action       |
| --------------- | --------------------- | ------------------------------------------------------------------- | --------------------- |
| OPS-PROBE-01    | cadence               | every 30 seconds                                                    | timeout 5 seconds     |
| OPS-ALERT-01    | consecutive failure   | 3 consecutive failures                                              | alert                 |
| OPS-ALERT-02    | rolling failure       | 50% failures within 5 minutes                                       | alert                 |
| OPS-RECOVERY-01 | recovery              | 3 consecutive successes                                             | recovery notification |
| OPS-ROUTING-01  | readiness failure     | stop new traffic                                                    | stop new traffic      |
| OPS-ROUTING-02  | health failure        | invoke restart policy                                               | invoke restart policy |
| OPS-DELIVERY-01 | notification delivery | configured operator channel within 5 minutes after condition is met | deliver notification  |

Backup failure、dead-letter job 或 oldest queue job above five minutes MUST alert immediately。Database/disk usage MUST warn at 80% and alert critical at 90%。

Repository MUST provide deploy、rollback、restore and queue-recovery runbooks。Formal on-call、burn-rate alerts and distributed tracing are P1。

Detailed requirement: see §20 for search-specific freshness and rebuild behavior。

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 31. Rate Limiting

至少保護：

- login
- registration
- password reset
- share-link access
- asset upload
- search
- runtime-related APIs
- export
- public note access where abuse risk exists

Rate-limit storage 必須抽象，避免綁死單一 local implementation。

---

## 32. Security Requirements

Security Requirements is the sole authority for the security implementation baseline。GlyphQuire implementation MUST comply with applicable requirements from these fixed baselines：

- [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release) Level 2
- [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b/) for authentication and session management
- [SLSA 1.2](https://slsa.dev/spec/v1.2/) Build Level 1 for release provenance

Living implementation references：

| Reference          | Direct URL                                                                                             | Reviewed   | Upstream commit                          |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------- |
| Authentication     | https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html                         | 2026-08-19 | 6b8819da79e0537d072e04296ffa3adfc94ba881 |
| Session Management | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html                     | 2026-08-19 | 6b8819da79e0537d072e04296ffa3adfc94ba881 |
| CSRF               | https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html  | 2026-08-19 | 6b8819da79e0537d072e04296ffa3adfc94ba881 |
| XSS Prevention     | https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html        | 2026-08-19 | 6b8819da79e0537d072e04296ffa3adfc94ba881 |
| SSRF Prevention    | https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html | 2026-08-19 | 6b8819da79e0537d072e04296ffa3adfc94ba881 |
| File Upload        | https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html                            | 2026-08-19 | 6b8819da79e0537d072e04296ffa3adfc94ba881 |
| WHATWG HTML        | https://html.spec.whatwg.org/                                                                          | 2026-08-19 | 40814ebfef1506a621a4af1ebd7e80c048cc396e |
| W3C CSP Level 3    | https://www.w3.org/TR/CSP3/                                                                            | 2026-08-19 | e81d712e979255b8291579854e168f0021b5b0da |

Pinned review records：

- Authentication — Reviewed: 2026-08-19；Upstream commit: 6b8819da79e0537d072e04296ffa3adfc94ba881
- Session Management — Reviewed: 2026-08-19；Upstream commit: 6b8819da79e0537d072e04296ffa3adfc94ba881
- CSRF — Reviewed: 2026-08-19；Upstream commit: 6b8819da79e0537d072e04296ffa3adfc94ba881
- XSS Prevention — Reviewed: 2026-08-19；Upstream commit: 6b8819da79e0537d072e04296ffa3adfc94ba881
- SSRF Prevention — Reviewed: 2026-08-19；Upstream commit: 6b8819da79e0537d072e04296ffa3adfc94ba881
- File Upload — Reviewed: 2026-08-19；Upstream commit: 6b8819da79e0537d072e04296ffa3adfc94ba881
- WHATWG HTML — Reviewed: 2026-08-19；Upstream commit: 40814ebfef1506a621a4af1ebd7e80c048cc396e
- W3C CSP Level 3 — Reviewed: 2026-08-19；Upstream commit: e81d712e979255b8291579854e168f0021b5b0da

A baseline refresh MUST update the direct URL、review date and official commit before compliance review。

Implementation MUST maintain a security compliance matrix。Each relevant requirement is marked `applicable`、`implemented` with evidence、or `documented exception`。Exception MUST record rationale、risk、compensating control and approver。Release evidence includes applicable automated tests/scans and required manual verification。External control catalogs are referenced, not copied into this specification。

### 32.1 Web

- Content Security Policy
- secure cookies in HTTPS
- HttpOnly session cookies
- SameSite policy
- CSRF defense according to auth flow
- clickjacking policy
- Referrer-Policy
- MIME sniffing protection
- origin validation

### 32.2 Content

- raw HTML disabled by default
- sanitize rendered external content
- validate URLs
- block dangerous URL schemes
- external embed allowlist
- SVG treated as active content

### 32.3 Sandbox

- different origin
- minimal iframe sandbox capability
- no auth cookies
- no application tokens
- no unrestricted internal API
- origin-check `postMessage`
- schema-check messages
- code size limits
- execution controls

### 32.4 Database

- parameterized queries / ORM
- least-privilege DB credentials
- migrations run by privileged deployment role where practical
- application role does not require schema-owner privileges

### 32.5 Secrets

Local `.env` only for development.

Production secrets must be supplied by deployment environment/secret manager.

Never commit:

```text
DATABASE_URL
BETTER_AUTH_SECRET
S3_SECRET
R2_TOKEN
SMTP_PASSWORD
```

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 33. Backups and Data Lifecycle

Backups and Data Lifecycle is the sole authority for production recoverability、export、retention and deletion。

Official hosted production MUST：

- create encrypted PostgreSQL and Object Storage backups at least daily
- retain backups for 30 days
- create an additional backup before destructive migration
- run a full restore drill monthly
- verify notes、revisions、asset relationships and content hashes after restore
- retain each drill result

Maximum accepted data-loss window is 24 hours。This is a recovery target, not an availability SLA。「有 backup file」不視為完整 strategy；restore evidence is required。

Data lifecycle：

- User export MUST include Markdown、assets and required metadata。
- Deleted note remains recoverable for 30 days and is then permanently deleted。
- Confirmed account/workspace deletion MUST remove primary records、versions、assets、search records、share links and pending jobs within 30 days。
- Revoked share link MUST stop working immediately。
- Backup copies expire through the 30-day retention cycle；historical backups are not modified record-by-record。
- Audit/security logs are retained for 90 days and MUST NOT contain document bodies、credentials or secrets。

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 34. Local Development and Preview Deployment

### 34.1 Docker Compose services

```text
reverse-proxy
web
api
worker
sandbox
postgres
minio
```

Optional observability services 可放 profile。

### 34.2 Local origin layout

推薦：

```text
http://app.localhost
    ├─ /
    └─ /api/*

http://sandbox.localhost
```

Reverse proxy：

```text
app.localhost/
→ web

app.localhost/api/*
→ api

sandbox.localhost/
→ sandbox
```

如此 frontend 與 API 可維持同 site/origin 的簡單 auth flow，同時 sandbox 保持獨立 origin。

### 34.3 Local development

```text
pnpm dev
```

可直接啟動各 app。

Dependency services：

```text
docker compose up postgres minio
```

Full self-host preview：

```text
docker compose up --build
```

---

## 35. Cloudflare Migration Strategy

Cloudflare portability 維持為架構約束，非 P0 必要 runtime。從 v1 開始遵守 portability constraints。

### 35.1 Mapping

```text
Local                         Cloudflare

Vue/Vite static build   →     Workers Static Assets
Hono API                →     Cloudflare Worker
PostgreSQL              →     PostgreSQL + Hyperdrive
MinIO                   →     R2
Graphile Worker         →     Cloudflare Queues
Local Worker            →     Queue Consumer Worker
sandbox service         →     isolated Worker/static origin
```

### 35.2 PostgreSQL

不將核心資料層改成 D1。

理由：

- PostgreSQL 是既定 canonical database
- 使用 PostgreSQL FTS
- Drizzle schema 已以 PostgreSQL 為中心
- 未來透過 Hyperdrive 從 Workers 存取既有 PostgreSQL

### 35.3 Runtime portability rule

Backend domain code 優先使用 Web Standard APIs：

- `Request`
- `Response`
- `URL`
- `Headers`
- Web Crypto
- Web Streams

Node.js-specific API 若非必要不得滲入 domain packages。

任何需要 Node.js-specific package 的依賴都必須先確認 Workers compatibility，且以 adapter 隔離。

### 35.4 Cloudflare-specific code

只能位於：

```text
apps/*
packages/*/adapters/cloudflare
infra/cloudflare
```

不得散落 document-engine 或 domain service。

---

### 35.5 Public rendering strategy

v1 採 SPA-first：

- Vue 3 + Vite
- editor 與 public note viewer 共用 client rendering stack
- v1 不以 SEO / SSR 為 acceptance criterion

後期若 public notes 的 SEO、social preview 或 cacheability 成為核心需求，優先演進成獨立 public renderer，而非把 editor 強迫遷入 SSR lifecycle。

## 36. Testing Strategy

Detailed requirement: see §40 for the benchmark profile and §41 for browser/accessibility evidence。

### 36.1 Unit tests

優先覆蓋：

- parser
- serializer
- validator
- migrations
- theme resolver
- authorization
- runtime protocol
- asset validation

### 36.2 Golden tests

Markdown fixture：

```text
input.md
expected.ast.json
expected.md
```

每個 custom block 至少有：

- valid
- invalid
- nested
- malformed
- round-trip
- migration

### 36.3 Property tests

Document Engine 適合 property-based testing：

- parse/serialize stability
- migration idempotency
- malformed input never crashes process

### 36.4 Integration tests

- Hono API + PostgreSQL
- auth
- autosave + optimistic concurrency
- storage adapter
- queue
- version restore

### 36.5 Browser E2E

Detailed requirement: see §41 for supported browsers and accessibility evidence。

Playwright：

- create note
- visual/source switch
- autosave
- reload
- upload asset
- share note
- theme switch
- execute p5 block
- sandbox isolation
- revision conflict

---

## 37. Release and Migration Contract

Release and Migration Contract is the sole authority for CI、release identity、deployment approval、rollback and migration compatibility。

GitHub Actions Pull Request workflow MUST pass：

```text
typecheck
lint
unit tests
integration tests
document golden tests
build
```

Main branch MUST additionally run core Playwright E2E and security baseline checks。

Production release identity MUST include：

- Git tag
- immutable Docker image digest
- database migration version
- document migration version

Production deployment MUST require manual approval and health/readiness checks。Previous image MUST remain deployable；failed health checks trigger application rollback。

Schema changes MUST use expand/contract compatibility so old and new application versions can operate during the deployment window。Data recovery uses forward repair plus preserved source/snapshots；destructive schema rollback is not the default recovery strategy。

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 38. Database Migrations

Detailed requirement: see §37 for release、compatibility and recovery policy。

Drizzle migration files 必須納入 version control。

流程：

```text
schema change
→ generate migration
→ inspect SQL
→ test against disposable DB
→ backup
→ deploy backward-compatible expand migration
→ deploy compatible application
→ verify health and data
→ remove old schema only in a later contract migration
```

禁止 production startup 自動執行未審查 schema push。

---

## 39. Document Migrations

Detailed requirement: see §19 for revision/history semantics and §37 for release/recovery policy。

Database migration 與 document migration 分開。

例如：

```text
Markdown Spec v1
↓
Markdown Spec v2
```

migration：

```ts
migrateDocument(markdown, 1, 2);
```

需求：

- deterministic
- tested
- reversible where practical
- versioned
- failure does not destroy source

批次 migration 前必須建立 snapshot。

---

## 40. Performance Targets

Performance Targets is the sole authority for release benchmark behavior。These are release gates, not an external SLA。

### 40.1 Reference environment

- Linux x86-64、4 vCPU、8 GB RAM
- API、Worker、PostgreSQL and Object Storage run under Docker Compose on one host
- client and server use the same test network
- five workspaces with 1,000 notes each
- report records CPU、RAM、image digest、data volume and test version

Typical case is one active personal-notebook user；burst ceiling is five concurrent users。This benchmark profile does not prescribe production topology。

### 40.2 UI measurements

Playwright performance marks MUST implement these exact boundaries：

| ID         | Operation            | Warm-up      | Samples       | Measurement boundary                                                   | Gate            |
| ---------- | -------------------- | ------------ | ------------- | ---------------------------------------------------------------------- | --------------- |
| PERF-UI-01 | 100 KB input         | 100 warm-ups | 1,000 samples | InputEvent dispatch -> next animation frame containing rendered change | p95 < 100 ms    |
| PERF-UI-02 | Visual/Source switch | 10 warm-ups  | 100 samples   | triggering action -> target editor accepts input                       | p95 < 1 second  |
| PERF-UI-03 | 1 MB open            | 5 warm-ups   | 100 samples   | request dispatch -> editor accepts input                               | p95 < 5 seconds |
| PERF-UI-04 | 1 MB save            | 5 warm-ups   | 100 samples   | request dispatch -> server acknowledgment and saved UI state           | p95 < 5 seconds |
| PERF-UI-05 | 1 MB export          | 5 warm-ups   | 100 samples   | action -> downloadable blob ready                                      | p95 < 5 seconds |

Continuous typing MUST produce no main-thread task above 200 ms。Full parse/validation above 100 KB MUST run in a Web Worker or use interruptible processing。

### 40.3 Thirty-minute burst workload

Each of five users continuously edits one 100 KB note、autosaves every two seconds、searches every ten seconds and uploads one 5 MB asset every five minutes。

The run permits no data loss、revision regression、unexpected `5xx` or dead-letter job。After traffic stops, search/index queue MUST drain within 60 seconds。Every successful autosave revision MUST be readable through the API and match its expected content hash。

### 40.4 API sampling

Measure `GET note`、`PUT autosave` and `GET search` separately。Each route requires at least 500 samples after a two-minute warm-up；report p50、p95 and p99。

- `GET note` p95 < 500 ms
- `GET search` p95 < 500 ms
- `PUT autosave` p95 < 1 second

Any timeout、unexpected `5xx` or data-integrity failure fails the gate regardless of percentiles。Autosave MUST NOT send unnecessary derived HTML；asset upload MUST NOT embed frontend base64 in the JSON API。

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 41. Accessibility and Browser Support

Accessibility and Browser Support is the sole authority for supported clients and accessibility evidence。

P0 supports the latest two stable releases of Chrome、Firefox、Safari and Edge。Desktop receives full editing support。Mobile MUST support reading and basic management；a complete mobile visual editor is P1。

v1 built-in components 必須：

- keyboard navigable
- semantic HTML
- focus visible
- reduced-motion support
- theme contrast validation where practical
- toggle 使用正確 `aria-expanded`
- interactive runtime 提供 fallback/title

Built-in UI MUST meet WCAG 2.2 AA。Release evidence MUST include：

- axe checks in CI
- keyboard-only core flows
- visible-focus and reduced-motion checks
- one core-flow smoke test using VoiceOver or NVDA

動畫 theme 必須尊重：

```css
@media (prefers-reduced-motion: reduce);
```

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 42. Internationalization

UI text 不得硬編碼於 component logic。

v1 architecture 預留 i18n message layer。

Document content 本身不做強制 translation。

---

## 43. Product v1 Scope

v1 product feature scope（功能範圍，非 release blocker 優先級；release blocker 由 §49 Production Readiness Contract 定義）：

1. 註冊、登入、登出。
2. 建立、讀取、更新、刪除筆記。
3. Markdown canonical persistence。
4. Milkdown Visual Mode。
5. CodeMirror Source Mode。
6. stable round-trip。
7. 基本 extended blocks：
   - callout
   - sticky note
   - toggle
   - tabs
   - columns
8. p5.js/Canvas sandbox block。
9. theme switch。
10. custom design-token theme。
11. autosave。
12. version history + restore。
13. asset upload。
14. PostgreSQL FTS。
15. import/export Markdown。
16. read-only share link。
17. Docker Compose local development and preview。
18. backup/restore。
19. structured logging。
20. rate limiting。
21. sandbox security tests。
22. core E2E tests。

Production readiness requirements (P0/P1 priority, evidence, and acceptance criteria): see §49。

---

## 44. Development Milestones

### Phase 0 — Foundation

- monorepo
- TypeScript config
- Vue/Vite shell
- Hono API
- PostgreSQL
- Drizzle
- Better Auth
- CI
- Docker Compose

### Phase 1 — Document Engine

- Markdown v0.1 spec
- parser
- AST
- validator
- serializer
- round-trip tests
- migration framework

此階段完成前，不大量開發 visual components。

### Phase 2 — Editors

- Milkdown
- CodeMirror 6
- mode synchronization
- diagnostics
- autosave
- revision conflict

### Phase 3 — Component + Theme

- registry
- built-in components
- theme engine
- design tokens
- theme editor
- plugin manifest foundation

### Phase 4 — Interactive Runtime

- sandbox host
- runtime protocol
- p5
- canvas
- stop/reset/timeout
- CSP
- security tests

### Workspace Services

- assets
- search
- versions
- import/export
- share links
- queue/worker

### Release and Operations

Production release requires passing all P0 items in §49 Production Readiness Contract。

- observability
- backups
- rate limits
- security headers
- accessibility
- performance profiling
- deployment docs
- compliance matrix
- runbooks

---

## 45. Later Features

後期僅保留 roadmap，不納入 v1 acceptance criteria。P1 production-readiness items 列於 §49.4；以下為 product feature roadmap：

- Y.js collaborative editing
- presence / remote cursor
- comments
- offline/PWA
- note backlinks
- graph view
- tags
- folders/collections
- templates
- reusable content snippets
- Mermaid
- charts
- timeline
- quiz/flashcards
- plugin marketplace
- signed plugins
- restricted custom CSS
- additional interactive runtimes
- public themes gallery
- PDF export
- static-site export
- Obsidian vault import/export
- mobile layout/editor improvements
- semantic/vector search
- AI-assisted editing
- workspace audit UI
- organization/enterprise roles
- passkeys / 2FA
- SSO
- self-hosted production documentation and support
- Cloudflare deployment profile
- independent public renderer / pre-rendering when SEO becomes a product requirement
- Cloudflare Queues adapter
- R2 adapter
- Hyperdrive adapter
- Durable Objects for future realtime coordination
- CDN/public note caching
- custom domains

---

## 46. Key Architecture Decisions

以下 ADR 已於 2026-08-19 決定。

### ADR-001: Generic directive grammar

Accepted.

Custom Markdown blocks 採 `remark-directive` compatible syntax：

```md
:::callout{type="warning" title="注意"}
Content
:::
```

不自製 YAML-like metadata grammar。

### ADR-002: MDAST + Notebook Semantic AST

Accepted.

```text
Markdown
→ MDAST
→ Semantic Transform
→ Notebook Semantic AST
```

MDAST 保留 Markdown syntax semantics；Notebook AST 提供 product/domain semantics。

### ADR-003: Milkdown maps to MDAST, not Notebook AST

Accepted.

```text
                 ┌→ Notebook Semantic AST → Validator / Renderer / Search
Markdown → MDAST ┤
                 └↔ Milkdown / ProseMirror
```

避免重寫 Milkdown 的 Remark transformation architecture。

### ADR-004: Graphile Worker for local jobs

Accepted.

Local background queue 採 Graphile Worker。所有 task handler 以 at-least-once delivery 為假設，必須 idempotent。Cloudflare deployment 後以 QueuePort adapter 替換為 Cloudflare Queues。

### ADR-005: Hybrid PostgreSQL search

Accepted.

- PostgreSQL FTS：英文與一般 tokenized text
- `pg_trgm`：CJK / fuzzy matching
- normalized exact/fallback matching

Search implementation 由 `SearchPort` 隔離。

### ADR-006: Logical asset URI

Accepted.

Canonical Markdown 使用：

```text
asset://<asset-id>
```

Storage/provider URL 為 derived value。

### ADR-007: Built-in presets + declarative user-defined blocks

Accepted.

產品提供內建 block；使用者也可以建立 declarative custom block。Main application runtime 不允許 user-defined arbitrary Vue/JavaScript。

### ADR-008: Design Tokens + approved variants

Accepted.

v1 theme customisation 限於 Design Tokens 與 Component Variants。不開放 unrestricted CSS。

### ADR-009: Sandbox network deny-by-default with allowlist capability

Accepted.

Sandbox 預設無 network。進階互動 block 可要求 explicit network allowlist；runtime 只授予驗證後的 host/origin capability。

### ADR-010: SPA-first public rendering

Accepted.

v1 使用 Vue 3 + Vite SPA，不因 public notes 導入 Nuxt/SSR。後期若 SEO 成為核心需求，再建立獨立 public renderer/pre-render layer。

---

## 47. Resolved Design Baseline

上述 ADR 使 v1 architecture baseline 固定為：

```text
GFM + Generic Directives
          │
          ▼
        MDAST
      ┌───┴───────────┐
      ▼               ▼
Notebook AST      Milkdown
      │               │
      ├ Validator     └ ProseMirror
      ├ Renderer
      ├ Search Extractor
      ├ Migration
      └ Component Registry
```

Markdown grammar 的正式定義、built-in directive names、attributes、nesting、escaping、unsupported behavior、Semantic AST schema 與 round-trip rules 以 `MARKDOWN_SPEC.md` 為準。

## 48. Definition of Done

一個 feature 只有在以下條件成立時才視為完成：

- TypeScript strict mode 無錯誤
- API/input schema validation
- authorization covered
- unit/integration tests
- relevant E2E test
- error path defined
- logging does not leak secrets/content
- migration considered
- local Docker deployment works
- Cloudflare portability impact reviewed
- security boundary reviewed if handling user content/code
- documentation updated

Production release priority and evidence: see §49 Production Readiness Contract。

---

## 49. Production Readiness Contract

Production Readiness Contract is the sole consolidated release checklist for the first officially hosted, multi-tenant GlyphQuire SaaS。

### 49.1 Priority Semantics

- **P0** blocks the first official production release。Every P0 item requires observable acceptance evidence；unsupported claims such as "considered" or "supported" do not pass。
- **P1** does not block the first release, but the P0 architecture MUST leave an explicit evolution path without retaining obsolete compatibility layers。P1 is not a delivery commitment without a later approved plan。

### 49.2 Workload and Non-Promises

The typical initial workload is one active personal-notebook user；burst ceiling is five concurrent users。

P0 explicitly does NOT promise：

- an availability SLA
- high availability
- active multi-region failover
- operation beyond the stated workload

### 49.3 P0 Evidence Table

| P0-01 | Deployment scope           | Officially hosted multi-tenant SaaS with five-user burst ceiling                                                                         | §1 Purpose                                     | CI + Docker Compose integration test                              |
| ----- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| P0-02 | Transactional persistence  | Autosave: authorization, revision CAS, note update, snapshot, durable enqueue in one PostgreSQL transaction                              | §18 Autosave                                   | Integration test with concurrent revision                         |
| P0-03 | Tenant isolation           | Every resource belongs to exactly one workspace; every operation applies workspace scope server-side                                     | §16 Authorization                              | Integration test exercising cross-workspace rejection             |
| P0-04 | Markdown/version history   | Self-describing `glyphquire-spec` marker; import/restore/migration require `baseRevision`; monotonic revisions; failure preserves source | §19 Version History; `MARKDOWN_SPEC.md` §47    | Golden tests + integration test for conflict/restore              |
| P0-05 | Security baseline          | OWASP ASVS 5.0.0 L2, NIST 800-63B-4, SLSA 1.2 Build L1; living reference pins; compliance matrix                                         | §32 Security Requirements                      | Compliance matrix + automated scans + manual verification report  |
| P0-06 | Backup/data lifecycle      | Encrypted daily backups; 30-day retention; monthly restore drill; 24-hour RPO; deletion lifecycle                                        | §33 Backups and Data Lifecycle                 | Restore drill report with content-hash verification               |
| P0-07 | CI/release/migration       | GitHub Actions gates; Git tag + image digest + migration versions; manual approval; expand/contract compatibility                        | §37 Release and Migration Contract             | CI run + deployment log + rollback test                           |
| P0-08 | Small-workload performance | Reproducible benchmark: 4 vCPU/8 GB; UI p95 gates; 30-min burst with five users; API p95 gates                                           | §40 Performance Targets                        | Load report with environment/digest/data-volume record            |
| P0-09 | Observability/runbooks     | Structured logs; health/readiness probes; alert rules; notification delivery within 5 min                                                | §30 Operational Monitoring                     | Runbooks (deploy, rollback, restore, queue-recovery) + alert test |
| P0-10 | Search consistency         | 60-second freshness under P0 workload; query-time authorization; dead-letter handling; operator rebuild                                  | §20 Full-text Search                           | Integration test + dead-letter scenario + rebuild test            |
| P0-11 | First-party API            | `/api/v1` shared schemas; cursor pagination; idempotency keys; conditional mutations; versioned error envelopes                          | §24 API Design                                 | Contract test suite                                               |
| P0-12 | Custom Blocks              | Workspace-scoped; immutable published versions; unsupported placeholder; round-trip preservation                                         | §11.3 Custom Block API; `MARKDOWN_SPEC.md` §29 | Golden tests + integration test                                   |
| P0-13 | Conflict recovery          | `409` never overwrites; client retains draft across reload/crash; UI supports comparison/merge                                           | §10.3 Dirty State                              | E2E test with simulated conflict + reload                         |
| P0-14 | Browser/accessibility      | Latest 2 stable Chrome/Firefox/Safari/Edge; WCAG 2.2 AA; axe CI; keyboard flows; screen-reader smoke                                     | §41 Accessibility and Browser Support          | axe report + keyboard-only E2E + VoiceOver or NVDA smoke test     |

### 49.4 P1 Items

The following are explicitly non-blocking for the first production release：

- P1-01: Self-hosted production support — Docker Compose remains the local dev/preview path; formal self-hosted production documentation and support is P1。
- P1-02: High availability — active-active or active-passive failover。
- P1-03: Multi-region operation — cross-region replication and routing。
- P1-04: Formal availability SLO — external uptime commitments。
- P1-05: Distributed tracing — request-level cross-service trace propagation。
- P1-06: Complete operational dashboards — full Grafana/Prometheus dashboards beyond P0 probes and alerts。
- P1-07: Formal incident severity/on-call/escalation — structured incident management processes。
- P1-08: Public API and third-party tokens/SDKs — stable third-party developer contracts beyond first-party `/api/v1`。
- P1-09: Complete mobile visual editing — full Milkdown editing on mobile; P0 requires reading and basic management only。
- P1-10: Real-time collaboration/CRDT/automatic three-way merge — Y.js, presence, remote cursors。
- P1-11: Executable third-party plugins — sandboxed third-party block execution。
- P1-12: Scaling beyond five concurrent users — horizontal scaling, connection pooling, caching for larger workloads。

---

## 50. Implementation Order Warning

不得先大量製作漂亮 UI 再回頭決定 Markdown grammar。

最先需要穩定的是：

```text
Markdown Spec
→ AST
→ Validator
→ Serializer
→ Round-trip tests
→ Component contract
```

Milkdown node view、動畫、theme、p5 runtime 都建立於這個 contract 之上。

如果 grammar、AST 與 serializer 尚未穩定，先大量建立 UI component 會產生高昂的重構成本。

---

## 51. Initial Success Criterion

第一個真正 vertical slice 應完成以下流程：

```text
Create account
→ Create note
→ Source Mode 輸入 Markdown
→ 使用 :::callout
→ parser 建立 AST
→ Visual Mode 正確呈現
→ 修改內容
→ serialize 回 Markdown
→ autosave PostgreSQL
→ reload
→ AST round-trip 一致
→ change theme
→ same Markdown renders differently
```

第二個 vertical slice：

```text
Insert p5 block
→ parser identifies executable block
→ sandbox iframe initializes
→ code executes outside app origin
→ resize/error communicated through validated postMessage
→ reset/stop works
→ auth/session remains inaccessible to sandbox
```

完成這兩個 vertical slices 後，再擴充更多 block types 與產品功能。

---

## 52. Architecture Deepening Baseline

The production code uses five explicit ownership seams. These seams are the
only supported orchestration paths; obsolete aliases, fallback implementations,
and compatibility layers are removed rather than retained.

- **WorkbenchContext** owns route parsing, note/session generations, panel
  policy, mode transitions, and disposal. `Workbench.vue` is a rendering and
  event adapter only.
- **Worker registries** are assembled from domain factories with one injected,
  ready dispatcher. A handler never constructs its own dispatcher or reaches
  across domain registries.
- **SearchReadModule** owns cursor decoding, retrieval, ranking, hydration, and
  public error translation. `SearchQueryPort` is the read port; mutation jobs
  use `SearchPort`/`DerivedSearchMutationPort` and cannot perform reads.
- **TransferCoordinator** centralizes common request/scope-shape validation,
  bounded expiry calculation, scrubbed failure boundaries, idempotency replay,
  unique-race replay, transaction-owned row creation, and transactional enqueue.
  Import and export retain only membership/scope policy and artifact-specific
  behavior.
- **MigrationRunner** is the single executable migration path. It loads and
  validates the repository catalog, verifies the baseline/journal, then runs
  ordered migrations. Direct Drizzle migrator calls are not application entry
  points.

The repository toolchain is Oxc-only: `oxlint` is the linter and `oxfmt` is the
formatter. ESLint, Prettier, and compatibility scripts/configuration are not
supported. Vite 8.x uses Rolldown through the Oxc toolchain. Verification is
performed with `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`,
and the relevant package/integration suites.
