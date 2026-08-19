# SPEC.md — Extensible Markdown Notes Platform

> Status: Draft v0.2 — ADR decisions incorporated  
> Deployment target: Local-first / self-hosted, Cloudflare-ready  
> Primary language: TypeScript  
> Last updated: 2026-08-19

## 1. Purpose

本文件定義一套以 Markdown 為 canonical document format 的可擴充網頁筆記平台。產品目標是讓一般使用者以接近 Obsidian 的 Markdown 與少量延伸語法建立具有高度視覺風格、互動效果與可組合元件的筆記，同時讓進階使用者可在受控邊界內建立自訂 block、theme 與互動 runtime。

系統第一階段以本地部署與 self-hosted 為優先，架構不得綁死 Node.js-only API、單一 object storage、單一 job queue 或單一部署供應商。後續預計可將 frontend/API/worker 等服務遷移至 Cloudflare Workers 生態，並以 Hyperdrive 連接 PostgreSQL、R2 作為 object storage、Cloudflare Queues 作為背景任務佇列。

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
10. 第一版可完整 self-host，且核心 domain/service layer 應可搬遷到 Cloudflare Workers。

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
  parse(markdown: string, version?: number): ParseResult;
  validate(document: DocumentNode): ValidationResult;
  serialize(document: DocumentNode): string;
  migrate(markdown: string, from: number, to: number): MigrationResult;
  extractText(document: DocumentNode): string;
}
```

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
normalize(parse(serialize(parse(markdown))))
===
normalize(parse(markdown))
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
schemaVersion: number
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

```md
```p5
function setup() {
  createCanvas(600, 400)
}
```
```

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
```

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

v1 提供 built-in block presets，並允許使用者建立 declarative custom blocks。

Built-in preset 與 user-defined block 共用相同 Component Registry contract。使用者可以自訂新的 block 名稱與受控 schema，但不可把任意 Vue/JavaScript 注入 main application runtime。

允許：

- custom block name
- props schema
- nested content policy
- icon
- component preset / variant
- design-token mapping
- sandbox runtime request
- declarative composition of approved primitives

不允許：

- 在 main application origin 執行 arbitrary JS
- 直接 import server package
- 任意 filesystem access
- 任意 network credentials
- mutation application global state

---

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

後期可加入 restricted CSS sandbox。

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
<iframe sandbox="allow-scripts">
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

```md
```p5 {network=["https://api.example.com"]}
...
```
```

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

Password policy 與 account enumeration 防護由 security implementation 詳訂。

---

## 16. Authorization

Authentication 與 authorization 分離。

### 16.1 Roles

Workspace：

```text
owner
editor
viewer
```

### 16.2 Note visibility

```text
private
workspace
unlisted
public
```

### 16.3 Policy

所有 mutation API 必須 server-side authorization。

禁止依賴 frontend hidden buttons 作為安全控制。

API service 使用：

```ts
authorize(actor, action, resource)
```

作為統一 policy entry point。

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

### 18.1 Client behavior

建議：

- debounce 1–2 seconds
- network reconnect retry
- keep last unsaved local draft
- visible save state

### 18.2 Server behavior

每次 autosave：

1. authorization
2. validate document size
3. validate revision
4. update current note
5. increment revision
6. selectively create version snapshot
7. enqueue search-index job when needed

### 18.3 Version snapshot policy

避免每次按鍵建立版本。

snapshot trigger：

- significant content delta
- elapsed time threshold
- manual checkpoint
- before destructive migration
- before restore
- before major import

---

## 19. Version History

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

---

## 20. Full-text Search

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

## 21. Asset Manager

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

### 22.1 Import v1

- Markdown
- ZIP containing Markdown + assets

Import 必須：

- validate path traversal
- limit archive size
- limit file count
- validate custom syntax
- preserve unsupported syntax when possible

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
```

Hono RPC 作為 first-party frontend type-safe client。

External/public API 若後期提供，應另行維護 stable HTTP/OpenAPI contract，不將 Hono RPC internal types 直接視為永久 public API。

---

## 25. Input Validation

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
const body = await c.req.json() as SomeType;
```

直接信任 client type assertion。

---

## 26. Error Model

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

建立 `ErrorReporter` abstraction。

Local：

- console / structured log

Production：

- 可接 Sentry 或其他 provider

報告內容需經敏感資料 scrub。

---

## 30. Metrics

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

---

## 33. Backups

Local production/self-hosted 必須支援：

- PostgreSQL scheduled backup
- object storage backup strategy
- migration backup before destructive schema change
- restore procedure
- backup retention policy
- periodic restore test

「有 backup file」不視為完整 backup strategy；必須可驗證 restore。

---

## 34. Local Deployment

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

Cloudflare 不是 v1 runtime requirement，但從 v1 開始遵守 portability constraints。

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

## 37. Quality Gates

Pull Request 必須通過：

```text
typecheck
lint
unit tests
integration tests
document golden tests
build
```

Main branch 額外執行核心 Playwright E2E。

---

## 38. Database Migrations

Drizzle migration files 必須納入 version control。

流程：

```text
schema change
→ generate migration
→ inspect SQL
→ test against disposable DB
→ backup
→ deploy migration
→ deploy app
```

禁止 production startup 自動執行未審查 schema push。

---

## 39. Document Migrations

Database migration 與 document migration 分開。

例如：

```text
Markdown Spec v1
↓
Markdown Spec v2
```

migration：

```ts
migrateDocument(markdown, 1, 2)
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

初期 engineering target：

- 100 KB Markdown 文件：一般操作保持流暢
- 1 MB Markdown：可開啟，不保證所有高成本功能即時執行
- parse/validation 不得在大文件上長時間阻塞 UI thread
- expensive parsing 可移至 Web Worker
- autosave 不傳送不必要的 derived HTML
- asset upload 不經 frontend base64 塞入 JSON API

真正 production SLO 應在取得實測 workload 後制定，不先虛構精確 latency 保證。

---

## 41. Accessibility

v1 built-in components 必須：

- keyboard navigable
- semantic HTML
- focus visible
- reduced-motion support
- theme contrast validation where practical
- toggle 使用正確 `aria-expanded`
- interactive runtime 提供 fallback/title

動畫 theme 必須尊重：

```css
@media (prefers-reduced-motion: reduce)
```

---

## 42. Internationalization

UI text 不得硬編碼於 component logic。

v1 architecture 預留 i18n message layer。

Document content 本身不做強制 translation。

---

## 43. Product v1 Scope

v1 完成條件：

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
17. Docker Compose local deployment。
18. backup/restore documentation。
19. structured logging。
20. rate limiting。
21. sandbox security tests。
22. core E2E tests。

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

### Phase 5 — Product Services

- assets
- search
- versions
- import/export
- share links
- queue/worker

### Phase 6 — Production Hardening

- observability
- backups
- rate limits
- security headers
- accessibility
- performance profiling
- deployment docs

---

## 45. Later Features

後期僅保留 roadmap，不納入 v1 acceptance criteria：

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

---

## 49. Implementation Order Warning

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

## 50. Initial Success Criterion

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
