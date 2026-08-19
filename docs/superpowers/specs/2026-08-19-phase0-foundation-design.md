# Phase 0 — Foundation Design

> Status: Approved  
> Date: 2026-08-19  
> Scope: GlyphQuire Phase 0 — monorepo foundation, auth skeleton, dev infrastructure

---

## 1. Objective

Scaffold the GlyphQuire pnpm monorepo with all Phase 0 deliverables defined in SPEC.md §44: working TypeScript workspace, Vue/Vite frontend shell, Hono API server, PostgreSQL + Drizzle database layer, Better Auth integration (backend routes only, frontend placeholder), Docker Compose dev environment, and GitHub Actions CI.

Port interfaces for storage and queue are included to bridge Phase 1.

---

## 2. Monorepo Structure

```
/
├── pnpm-workspace.yaml
├── package.json                 # root scripts + shared devDeps
├── tsconfig.base.json           # strict, ES2022, ESNext modules
├── eslint.config.js             # flat config
├── .prettierrc
├── .env.example
├── .gitignore
├── docker-compose.yml           # dev: postgres + minio
├── .github/workflows/ci.yml
│
├── apps/
│   ├── web/                     # Vue 3 + Vite SPA
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.ts
│   │       ├── App.vue
│   │       ├── router/index.ts
│   │       ├── stores/           # Pinia (empty)
│   │       ├── layouts/
│   │       │   ├── AppLayout.vue
│   │       │   └── AuthLayout.vue
│   │       ├── pages/
│   │       │   ├── LoginPage.vue   # placeholder
│   │       │   ├── RegisterPage.vue # placeholder
│   │       │   └── HomePage.vue     # placeholder
│   │       └── lib/
│   │           └── api.ts          # Hono RPC client
│   │
│   └── api/                     # Hono API
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts          # server entry
│           ├── app.ts            # Hono app + middleware
│           ├── routes/
│           │   ├── health.ts
│           │   └── auth.ts       # Better Auth mount
│           ├── middleware/
│           │   ├── cors.ts
│           │   └── error-handler.ts
│           └── env.ts            # Zod env validation
│
├── packages/
│   ├── database/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── drizzle.config.ts
│   │   └── src/
│   │       ├── index.ts
│   │       ├── client.ts         # connection factory
│   │       ├── schema/
│   │       │   ├── index.ts
│   │       │   └── auth.ts       # users, sessions, accounts
│   │       └── migrations/       # drizzle-kit output
│   │
│   ├── auth/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── server.ts         # Better Auth server config
│   │       └── client.ts         # Better Auth client config
│   │
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── result.ts         # Result/Error types
│   │       └── env.ts            # shared env schema
│   │
│   ├── api-contract/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts          # Hono RPC type re-exports
│   │
│   ├── storage/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts          # StoragePort interface only
│   │
│   └── queue/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts          # QueuePort interface only
│
├── infra/
│   └── docker/                   # empty, Phase 6
│
└── tests/                        # empty, cross-service tests later
```

---

## 3. Technology Choices

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 22+ |
| Package manager | pnpm | 9+ |
| Language | TypeScript | 5.x, strict |
| Frontend | Vue 3 + Vite | latest |
| Router | Vue Router | 4 |
| State | Pinia | latest |
| CSS | Tailwind CSS | 4 |
| Editor framework | Milkdown, CodeMirror 6 | Phase 2 |
| API | Hono | latest |
| ORM | Drizzle | latest |
| Auth | Better Auth | latest |
| Database | PostgreSQL | 16+ |
| Object storage | MinIO (dev) | latest |
| Lint | ESLint (flat config) | 9+ |
| Format | Prettier | latest |

---

## 4. Package Details

### 4.1 packages/database

- Drizzle ORM with `drizzle-kit` for migrations
- PostgreSQL driver: `postgres` (postgres.js)
- Schema tables for Better Auth: `users`, `sessions`, `accounts`, `verifications`
- Connection factory reads `DATABASE_URL` from env
- Exports: schema types, client factory, migration utilities

### 4.2 packages/auth

- Better Auth server configuration (email/password provider)
- Better Auth client configuration (for Vue frontend)
- Depends on: `@glyphquire/database` for Drizzle adapter
- Exports: auth server instance, auth client factory

### 4.3 packages/shared

- `Result<T, E>` type for explicit error handling
- Shared Zod env schemas (DATABASE_URL, S3 config, etc.)
- Generic utility types

### 4.4 packages/api-contract

- Re-exports Hono RPC types from apps/api
- Provides typed API client factory for frontend

### 4.5 packages/storage (port only)

```typescript
export interface StoragePort {
  upload(key: string, data: Buffer | ReadableStream, contentType: string): Promise<StorageResult>;
  download(key: string): Promise<StorageObject>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn: number): Promise<string>;
}

export interface StorageResult {
  key: string;
  size: number;
  contentType: string;
}

export interface StorageObject {
  data: ReadableStream;
  contentType: string;
  size: number;
}
```

### 4.6 packages/queue (port only)

```typescript
export interface QueuePort {
  enqueue<T>(taskName: string, payload: T, options?: EnqueueOptions): Promise<string>;
}

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
}
```

---

## 5. Apps Details

### 5.1 apps/web

- Vue 3 SPA via Vite
- Vue Router: `/login`, `/register` (AuthLayout), `/` (AppLayout, placeholder)
- Pinia: empty store setup
- Tailwind CSS 4 configuration
- Auth pages: placeholder UI (form shells, no real auth flow wired)
- API client: typed Hono RPC client via `@glyphquire/api-contract`

### 5.2 apps/api

- Hono server with `@hono/node-server`
- `GET /api/health` returns `{ status: "ok", timestamp }`
- `ALL /api/auth/*` mounts Better Auth handler
- CORS middleware (configurable origins)
- Global error handler middleware
- Zod-based env validation at startup

---

## 6. Docker Compose (Dev)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: glyphquire_dev
      POSTGRES_USER: glyphquire
      POSTGRES_PASSWORD: glyphquire_dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U glyphquire"]
      interval: 5s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: glyphquire
      MINIO_ROOT_PASSWORD: glyphquire_dev
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data

volumes:
  pgdata:
  minio_data:
```

---

## 7. CI (GitHub Actions)

Workflow triggers: push to `main`, pull requests.

Steps:
1. Checkout
2. Setup Node.js 22 + pnpm
3. `pnpm install --frozen-lockfile`
4. `pnpm typecheck` (tsc --noEmit across workspace)
5. `pnpm lint`
6. `pnpm build`

---

## 8. .env.example

```env
# Database
DATABASE_URL=postgresql://glyphquire:glyphquire_dev@localhost:5432/glyphquire_dev

# Auth
BETTER_AUTH_SECRET=change-me-in-production
BETTER_AUTH_URL=http://localhost:3000

# S3 / MinIO
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=glyphquire
S3_SECRET_KEY=glyphquire_dev
S3_BUCKET=glyphquire-assets
S3_REGION=us-east-1

# App
API_PORT=3000
WEB_PORT=5173
CORS_ORIGIN=http://localhost:5173
```

---

## 9. Multi-Agent Execution Strategy

### Work Units

| Unit | Content | Dependencies | Agent |
|------|---------|-------------|-------|
| W1 | Root monorepo config | none | main session |
| W2 | packages/shared, api-contract, storage, queue | W1 | executor (worktree) |
| W3 | packages/database | W1, W2 | executor (worktree) |
| W4 | packages/auth | W1, W3 | executor (worktree) |
| W5 | apps/api | W1, W3, W4 | executor (worktree) |
| W6 | apps/web | W1 | executor (worktree) |
| W7 | Docker Compose + CI + .env.example | W1 | executor (worktree) |

### Execution Waves

- **Wave 0**: W1 (main session, synchronous)
- **Wave 1**: W2, W6, W7 (3 parallel agents)
- **Wave 2**: W3 (after W2 collected)
- **Wave 3**: W4 (after W3 collected)
- **Wave 4**: W5 (after W4 collected)

### Integration

Main session collects each worktree, merges into main, resolves any conflicts, and runs final `pnpm install && pnpm typecheck && pnpm build` validation.
