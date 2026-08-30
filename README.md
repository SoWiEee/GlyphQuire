# GlyphQuire

<p align="center">
  <strong>以 Markdown 為核心，為知識、研究與創作打造的可擴充筆記工作空間。</strong>
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white">
  <img alt="Vue" src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white">
  <img alt="Milkdown" src="https://img.shields.io/badge/Editor-Milkdown-7C3AED">
  <img alt="CodeMirror" src="https://img.shields.io/badge/Source-CodeMirror%206-D30707">
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind_CSS-3-06B6D4?logo=tailwindcss&logoColor=white">
  <img alt="Hono" src="https://img.shields.io/badge/API-Hono-E36002">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16+-4169E1?logo=postgresql&logoColor=white">
  <img alt="Drizzle" src="https://img.shields.io/badge/ORM-Drizzle-C5F74F">
</p>

> **目前狀態：開發中。**  
> GlyphQuire 目前以本地部署與 self-hosted 為主要開發目標，後續預計支援 Cloudflare Workers、R2、Queues 與 PostgreSQL + Hyperdrive 部署架構。

> 工程規格文件 [SPEC.md](docs/SPEC.md)，Markdown 與 Custom Block 語法 [MARKDOWN_SPEC.md](docs/MARKDOWN_SPEC.md)。若兩份規格與實作發生衝突，前者負責 Application / System Architecture，後者負責 Markdown grammar / AST / serialization。

---

## What is GlyphQuire

## Product Demo

<table>
  <tr>
    <td align="center"><img src="docs/assets/readme/01-editor-modes.png" alt="Visual and Source editing modes" width="100%"><br><sub>Visual / Source editing</sub></td>
    <td align="center"><img src="docs/assets/readme/02-semantic-blocks.png" alt="Semantic Markdown blocks" width="100%"><br><sub>Callout, Toggle, Tabs, Columns</sub></td>
    <td align="center"><img src="docs/assets/readme/03-search-transfer.png" alt="Search and import/export tools" width="100%"><br><sub>Search and transfer</sub></td>
    <td align="center"><img src="docs/assets/readme/04-sharing-maintenance.png" alt="Read-only sharing and maintenance" width="100%"><br><sub>Sharing and maintenance</sub></td>
  </tr>
</table>

_Screenshots are deterministic local-demo captures; they contain no production data._

GlyphQuire 是一套以 **Markdown 作為唯一文件來源格式（canonical format）** 的可擴充網頁筆記工具。

它保留 Markdown 容易閱讀、容易備份、容易搬移的特性，同時加入語意化的延伸語法，讓使用者不需要直接撰寫 HTML、CSS 或 JavaScript，就能建立更豐富的筆記內容。

例如：

<!-- prettier-ignore -->
```md
# GPU Scheduling

:::callout{type="warning" title="注意"}
MPS 不應被視為完整的 GPU memory isolation 機制。
:::

:::toggle{title="查看實驗設定"}
- RTX 4070
- RTX 3080
- NVIDIA MPS
:::
```

同一份 Markdown 可以由不同 Theme 呈現成完全不同的視覺風格，而文件內容本身不需要跟著修改。

進階使用者則可以透過受控的 Custom Block、Theme 與 Sandbox Runtime，建立自己的筆記元件或互動內容，例如 p5.js、Canvas 等。

---

## Core Concept

### Markdown 永遠是文件本體

GlyphQuire 將 Markdown 視為唯一可信的文件來源。

```text
Markdown
   │
   ▼
 MDAST
   │
   ▼
GlyphQuire Semantic AST
   │
   ├── Renderer
   ├── Validator
   ├── Search
   ├── Migration
   └── Component Registry
```

Milkdown、CodeMirror、HTML Preview、搜尋索引以及其他格式都只是 Markdown 的編輯或衍生表示。

這代表你的筆記不會因為 GlyphQuire 停止維護，就變成難以解析的私有 JSON 文件。

### 內容與樣式分離

```md
:::callout{type="danger"}
這是一段重要內容。
:::
```

這段 Markdown 只描述「這是一個 danger callout」。

至於它要呈現成：

- 便條紙
- 玻璃卡片
- 紅色警示框
- 動態光暈
- 極簡學術風格

則完全交給 Theme Engine 決定。

### 逐步增加複雜度

一般使用者只需要：

```md
# 標題

普通 Markdown。
```

想使用進階版面時：

```md
:::toggle{title="詳細內容"}
...
:::
```

需要圖像或互動時才使用：

<!-- prettier-ignore -->
````md
:::p5{height="400"}
```js
function setup() {
  createCanvas(600, 400)
}
```
:::
````

不需要為了漂亮的筆記直接接觸 Vue、DOM 或底層應用程式程式碼。

---

# ⭐ Features

## 雙模式 Markdown 編輯

GlyphQuire 提供兩種編輯方式，包含 Visual 及 Source 模式。

### Visual Mode

由 Milkdown 提供視覺化 Markdown 編輯體驗。

適合：

- 日常筆記
- 快速排版
- Slash Command
- Callout / Toggle 等語意區塊
- 不想直接操作 Markdown 語法的使用者

### Source Mode

由 CodeMirror 6 提供完整 Markdown source editing。

包含：

- Syntax Highlighting
- 自訂 GlyphQuire 語法提示
- Schema Diagnostics
- Autocomplete
- 格式錯誤提示
- 未來的版本 Diff View

兩種模式使用同一份 Markdown，不會維護兩套獨立文件格式。

---

## Markdown Syntax

以 GitHub Flavored Markdown 為基礎，並使用 Generic Directive 語法提供額外功能。

### Callout

```md
:::callout{type="warning" title="注意"}
這是一個警告區塊。
:::
```

可用類型：

```text
info
note
tip
warning
danger
success
```

### Sticky Note

```md
:::sticky{tone="yellow" title="記得"}
下週重新檢查實驗結果。
:::
```

### Toggle

<!-- prettier-ignore -->
```md
:::toggle{title="查看更多"}
這裡可以包含完整的 Markdown。

- List
- **Bold**
- `code`
:::
```

### Tabs

```md
::::tabs

:::tab{title="Vue"}
Vue 內容
:::

:::tab{title="Svelte"}
Svelte 內容
:::

::::
```

### Columns

```md
::::columns{count="2"}

:::column
左側內容。
:::

:::column
右側內容。
:::

::::
```

完整語法規格請參閱 [MARKDOWN_SPEC.md](docs/MARKDOWN_SPEC.md)。

---

## Theme Engine

- Theme 不會修改你的 Markdown。
- 相同文章 (markdown) 可以套用不同 Theme，例如 Academic, Minimal, Glass, Dark。
- Theme 可以控制的樣式包含：
  - Color Palette
  - Typography
  - Heading Decoration
  - Spacing
  - Border Radius
  - Quote Style
  - Callout Style
  - Toggle Style
  - Shadow
  - Hover Effect
  - Animation

### 使用者自訂 Theme

GlyphQuire v1 採用 **Design Tokens + Approved Component Variants**。例如：

```json
{
  "tokens": {
    "accent": "#8b5cf6",
    "background": "#ffffff"
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

基於安全與版面隔離考量，v1 不直接允許 unrestricted global CSS。

---

## Custom Blocks

GlyphQuire 內建常用區塊，同時允許使用者自行建立 declarative custom block。

例如建立一個 Rating Block：

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

之後即可在筆記中使用：

```md
:::user-rating{value="4" label="Readability"}
這篇論文整體可讀性不錯。
:::
```

Custom Block 可以定義：

- Block Name
- Property Schema
- Default Values
- Enum
- Number Range
- Nested Content
- Icon
- Renderer Preset
- Theme Token
- Sandbox Capability

為避免第三方內容直接取得應用程式權限，Custom Block 不允許直接將任意 Vue component 或 JavaScript 注入 GlyphQuire 主程式。

---

# 🕹️ Interactive Runtime

需要程式能力時，可以使用獨立的 Sandbox Runtime。

## p5.js

<!-- prettier-ignore -->
````md
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
````

## Canvas

<!-- prettier-ignore -->
````md
:::canvas{height="320"}
```js
const ctx = canvas.getContext("2d");

ctx.fillRect(10, 10, 100, 100);
```
:::
````

互動程式碼會在不同 origin 的 sandboxed iframe 執行：

```text
GlyphQuire App
     │
     │ postMessage
     ▼
Sandbox Runtime
     │
     ├── p5.js
     ├── Canvas
     └── Web Worker
```

Sandbox 預設無法存取：

- GlyphQuire Cookie
- Session Token
- localStorage
- Vue Application State
- Database Credentials
- Internal API Secret

網路權限預設關閉，未來可透過明確 allowlist 授予特定來源。

---

# 📦 Assets

GlyphQuire 不會把特定 Object Storage URL 寫死在 Markdown。

匯入圖片使用以下語法，`asset://` 會在顯示時解析到目前的 Storage Provider。

因此從 MinIO 遷移到 Cloudflare R2 時，不需要修改既有筆記內容。

```md
![Architecture](asset://01JABCDEF1234567890)
```

---

# ♻️ Version & Recovery

GlyphQuire 規劃提供：

- Autosave
- Revision Number
- Version History
- Manual Checkpoint
- Restore
- Revision Conflict Detection

當兩個編輯工作階段嘗試覆蓋同一篇筆記時，系統會偵測 revision conflict，避免靜默覆蓋另一份修改。

---

# 🔎 Search

搜尋採用 PostgreSQL Hybrid Search：

```text
英文與一般文字
→ PostgreSQL Full Text Search

中文 / CJK / fuzzy matching
→ pg_trgm

精確搜尋
→ normalized matching
```

搜尋索引會從 Semantic AST 抽取實際文字內容，而非直接索引：

```md
:::callout
```

之類的語法標記。

---

# Tech Stack

## Frontend

TypeScript
Vue 3
Vite
Tailwind CSS
Milkdown
CodeMirror 6

## Document Engine

GFM Markdown
remark-directive
MDAST
GlyphQuire Semantic AST
Schema Validator
Serializer
Document Migration

## Backend

Hono
Hono RPC
Better Auth
Zod
Drizzle ORM
PostgreSQL

## Infrastructure

Graphile Worker
MinIO
Docker Compose
Structured Logging
Metrics
Backup
Rate Limiting

## Interactive Runtime

Cross-origin iframe
postMessage RPC
p5.js
Canvas
Web Worker

---

# 🚀 Getting Started

> GlyphQuire 目前仍在開發階段，以下為專案預定的本地開發流程。

## 環境需求

建議安裝 Node.js 22+、pnpm、Docker、Docker Compose

```bash
git clone https://github.com/SoWiEee/GlyphQuire.git
cd GlyphQuire

pnpm install
docker compose up -d postgres minio     # 本地服務預計包含 PostgreSQL、MinIO
cp .env.example .env
pnpm db:migrate
pnpm dev
```

於 `.env` 至少需要設定：

```env
DATABASE_URL=postgresql://glyphquire_app:glyphquire_app_dev@localhost:5432/glyphquire_dev
MIGRATION_DATABASE_URL=postgresql://glyphquire_migration:glyphquire_migration_dev@localhost:5432/glyphquire_dev

BETTER_AUTH_SECRET=change-me

S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=glyphquire
S3_SECRET_KEY=change-me
S3_BUCKET=glyphquire
```

請勿將正式環境 Secret commit 至 Git。

既有 Phase 0 PostgreSQL volume 必須先依照
[Phase 0 to Phase 2 maintenance upgrade](docs/deployment/phase2-maintenance-upgrade.md)
停機、備份並建立分離的 migration/runtime roles；不可直接讓新舊 API 同時連線。

預計的本地域名 `http://app.localhost`、`http://sandbox.localhost`，Sandbox 使用獨立 origin，這是 GlyphQuire 的安全邊界之一。

---

# Docker 本地部署

完整 self-hosted 環境預計可透過：

```bash
docker compose up --build -d
```

啟動：

```text
reverse-proxy
web
api
worker
sandbox
postgres
minio
```

架構：

```text
                       ┌──────────────┐
                       │ Vue Web App  │
                       └──────┬───────┘
                              │
                        app.localhost
                              │
                       ┌──────▼───────┐
                       │   Hono API   │
                       └───┬──────┬───┘
                           │      │
              ┌────────────┘      └──────────────┐
              ▼                                  ▼
        PostgreSQL                            MinIO
              │
              ▼
       Graphile Worker


sandbox.localhost
        │
        ▼
Sandbox Runtime
```

---

# 自訂義

GlyphQuire 的自訂能力分成三個層級。

## Level 1：Theme

適合只想修改外觀的使用者。可調整的部分包含：

- 顏色
- 字型
- 圓角
- 間距
- Heading Decoration
- Quote Style
- Callout Style
- Animation

> 不需要修改 Markdown grammar。

---

## Level 2：Custom Block

適合希望加入新內容類型的使用者。例如：

- Rating
- Timeline
- Comparison
- Experiment Result
- Paper Summary
- Vocabulary Card

Custom Block 採 declarative schema，不需要操作 Vue 內部實作。

---

## Level 3：Interactive Runtime

真正需要程式能力時才使用：

- p5.js
- Canvas
- Web Worker

這個設計讓普通筆記維持簡單，同時保留進階使用者需要的程式化能力。

---

# Repo Layout

預計 monorepo：

```text
glyphquire/
├── apps/
│   ├── web/
│   ├── api/
│   ├── worker/
│   └── sandbox/
│
├── packages/
│   ├── document-engine/
│   ├── markdown-spec/
│   ├── components/
│   ├── component-sdk/
│   ├── theme-engine/
│   ├── theme-sdk/
│   ├── runtime-protocol/
│   ├── api-contract/
│   ├── database/
│   ├── storage/
│   ├── queue/
│   └── shared/
│
├── infra/
├── tests/
├── docs/
│   ├── SPEC.md
│   └── MARKDOWN_SPEC.md
│
└── README.md
```

---

# Cloudflare 路線

第一階段優先支援本地部署。

後續預計對應：

```text
Local                     Cloudflare

Vue/Vite              →   Workers Static Assets
Hono                  →   Cloudflare Workers
PostgreSQL            →   PostgreSQL + Hyperdrive
MinIO                 →   R2
Graphile Worker       →   Cloudflare Queues
Local Worker          →   Queue Consumer Worker
Sandbox Host          →   Isolated Worker / Static Origin
```

Document Engine 與核心 Domain Logic 不應直接依賴 Cloudflare-specific API。

---

# Future Work

目前規劃中的後期功能：

- Y.js 多人即時協作
- Remote Cursor
- Comments
- Offline / PWA
- Backlinks
- Graph View
- Tags
- Folder / Collection
- Templates
- Mermaid
- Chart
- Timeline
- Quiz / Flashcard
- Plugin Marketplace
- Theme Gallery
- Restricted Custom CSS
- PDF Export
- Static Site Export
- Obsidian Vault Import / Export
- Semantic Search
- AI-assisted Editing
- Passkeys / 2FA
- Cloudflare Deployment Profile
- Public Renderer / SEO Pre-rendering
- Custom Domain

---

# License

授權方式尚未決定。

在正式開源前，需要進一步確認：

- Project License
- Contributor License Policy
- Third-party Dependency Licenses
- Plugin / Theme Distribution Policy

---

<p align="center">
  <strong>GlyphQuire</strong><br>
  Write in Markdown. Shape it your way.
</p>
