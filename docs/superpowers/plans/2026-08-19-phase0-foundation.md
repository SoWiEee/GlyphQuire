# Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the GlyphQuire pnpm monorepo with working TypeScript workspace, Vue/Vite frontend shell, Hono API server, PostgreSQL + Drizzle database layer, Better Auth backend routes (frontend placeholder only), Docker Compose dev environment, and GitHub Actions CI.

**Architecture:** pnpm workspace monorepo with `apps/` (web, api) and `packages/` (database, auth, shared, api-contract, storage, queue). Ports-and-adapters pattern for external systems. TypeScript strict mode throughout. Packages use workspace protocol (`workspace:*`) for internal dependencies.

**Tech Stack:** Node.js 22+, pnpm 9+, TypeScript 5.x strict, Vue 3, Vite, Vue Router 4, Pinia, Tailwind CSS 4, Hono, @hono/node-server, Drizzle ORM, drizzle-kit, postgres (postgres.js), Better Auth, Zod, ESLint 9 flat config, Prettier, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-19-phase0-foundation-design.md`

## Global Constraints

- Node.js >= 22, pnpm >= 9
- TypeScript strict mode in all packages and apps
- Package directories use `kebab-case`
- Functions/variables use `camelCase`, types/components use `PascalCase`
- All packages scoped under `@glyphquire/`
- Internal deps use `"workspace:*"` protocol
- No secrets in committed files; `.env.example` uses safe placeholders only
- No DOM dependencies in packages/ (document-engine portability rule from SPEC.md §3.4)
- Each package exports via `src/index.ts` barrel

## Multi-Agent Execution Strategy

This plan is organized into 7 tasks (W1–W7) designed for parallel agent execution:

- **Wave 0:** Task 1 (W1) — main session, synchronous — must complete first
- **Wave 1:** Tasks 2, 6, 7 (W2, W6, W7) — 3 parallel executor agents in worktrees
- **Wave 2:** Task 3 (W3) — after Task 2 merged — executor in worktree
- **Wave 3:** Task 4 (W4) — after Task 3 merged — executor in worktree
- **Wave 4:** Task 5 (W5) — after Task 4 merged — executor in worktree
- **Final:** Integration validation in main session

Each executor agent uses `isolation: "worktree"`. Main session merges each worktree result before launching dependent tasks.

---

### Task 1: Root Monorepo Configuration (W1)

**Files:**

- Create: `pnpm-workspace.yaml`
- Create: `package.json` (root)
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `.prettierrc`
- Modify: `.gitignore` (add dist, .env patterns if missing)

**Interfaces:**

- Consumes: nothing
- Produces: root workspace config that all other tasks depend on; `tsconfig.base.json` that all packages/apps extend; lint/format config

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "glyphquire",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22",
    "pnpm": ">=9"
  },
  "packageManager": "pnpm@9.15.9",
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "db:generate": "pnpm --filter @glyphquire/database generate",
    "db:migrate": "pnpm --filter @glyphquire/database migrate",
    "clean": "pnpm -r clean"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "eslint": "^9.28.0",
    "prettier": "^3.5.0",
    "typescript": "^5.8.0",
    "typescript-eslint": "^8.33.0",
    "@eslint/js": "^9.28.0",
    "globals": "^16.1.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": false,
    "outDir": "dist",
    "rootDir": "src"
  },
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `eslint.config.js`**

```javascript
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/", "**/node_modules/", "**/*.config.*"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
```

- [ ] **Step 5: Create `.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 6: Verify `.gitignore` has needed entries**

The existing `.gitignore` already covers `node_modules/`, `dist`, `.env`, `*.tsbuildinfo`. Verify `dist/` and `.env` patterns are present. Add if missing:

```
# Build output
dist/

# Drizzle
drizzle/
```

- [ ] **Step 7: Create placeholder directories**

```bash
mkdir -p apps/web apps/api
mkdir -p packages/database packages/auth packages/shared packages/api-contract packages/storage packages/queue
mkdir -p infra/docker
mkdir -p tests
```

- [ ] **Step 8: Run `pnpm install` to validate workspace**

```bash
pnpm install
```

Expected: installs root devDependencies, recognizes workspace packages (empty for now).

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json eslint.config.js .prettierrc .gitignore
git commit -m "feat: scaffold root monorepo configuration"
```

---

### Task 2: Packages — shared, api-contract, storage, queue (W2)

**Files:**

- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/result.ts`
- Create: `packages/shared/src/env.ts`
- Create: `packages/api-contract/package.json`
- Create: `packages/api-contract/tsconfig.json`
- Create: `packages/api-contract/src/index.ts`
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/src/index.ts`
- Create: `packages/queue/package.json`
- Create: `packages/queue/tsconfig.json`
- Create: `packages/queue/src/index.ts`

**Interfaces:**

- Consumes: `tsconfig.base.json` from Task 1
- Produces:
  - `@glyphquire/shared`: `Result<T, E>`, `AppError`, `createEnvSchema()`, `type Env`
  - `@glyphquire/api-contract`: placeholder re-export (populated when apps/api exists)
  - `@glyphquire/storage`: `StoragePort`, `StorageResult`, `StorageObject` interfaces
  - `@glyphquire/queue`: `QueuePort`, `EnqueueOptions` interfaces

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@glyphquire/shared",
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
    "build": "tsc",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/shared/src/result.ts`**

```typescript
export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

export interface AppError {
  code: string;
  message: string;
  cause?: unknown;
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = AppError>(error: E): Result<never, E> {
  return { ok: false, error };
}
```

- [ ] **Step 4: Create `packages/shared/src/env.ts`**

```typescript
import { z } from "zod";

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
});

export const s3EnvSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
});

export const authEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().url(),
});

export const appEnvSchema = z.object({
  API_PORT: z.coerce.number().default(3000),
  WEB_PORT: z.coerce.number().default(5173),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
});
```

- [ ] **Step 5: Create `packages/shared/src/index.ts`**

```typescript
export { type Result, type AppError, ok, err } from "./result.js";
export { databaseEnvSchema, s3EnvSchema, authEnvSchema, appEnvSchema } from "./env.js";
```

- [ ] **Step 6: Create `packages/storage/package.json`**

```json
{
  "name": "@glyphquire/storage",
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
    "build": "tsc",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 7: Create `packages/storage/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 8: Create `packages/storage/src/index.ts`**

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

- [ ] **Step 9: Create `packages/queue/package.json`**

```json
{
  "name": "@glyphquire/queue",
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
    "build": "tsc",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 10: Create `packages/queue/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 11: Create `packages/queue/src/index.ts`**

```typescript
export interface QueuePort {
  enqueue<T>(taskName: string, payload: T, options?: EnqueueOptions): Promise<string>;
}

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
}
```

- [ ] **Step 12: Create `packages/api-contract/package.json`**

```json
{
  "name": "@glyphquire/api-contract",
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
    "build": "tsc",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "hono": "^4.7.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 13: Create `packages/api-contract/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 14: Create `packages/api-contract/src/index.ts`**

```typescript
import { hc } from "hono/client";

// AppType will be imported from apps/api once it exists.
// For now, export the client factory pattern.
// After apps/api is built (Task 5), update this file to:
//   import type { AppType } from "../../../apps/api/src/app.js";
//   export type { AppType };
//   export function createApiClient(baseUrl: string) {
//     return hc<AppType>(baseUrl);
//   }

export type ApiClient = ReturnType<typeof hc>;

export function createApiClient<T>(baseUrl: string) {
  return hc<T>(baseUrl);
}
```

- [ ] **Step 15: Run install and typecheck**

```bash
pnpm install
pnpm --filter @glyphquire/shared typecheck
pnpm --filter @glyphquire/storage typecheck
pnpm --filter @glyphquire/queue typecheck
pnpm --filter @glyphquire/api-contract typecheck
```

Expected: all pass with zero errors.

- [ ] **Step 16: Commit**

```bash
git add packages/shared packages/storage packages/queue packages/api-contract
git commit -m "feat: add shared, storage, queue, and api-contract packages"
```

---

### Task 3: Package — database (W3)

**Files:**

- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/drizzle.config.ts`
- Create: `packages/database/src/index.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/schema/index.ts`
- Create: `packages/database/src/schema/auth.ts`
- Create: `packages/database/src/migrate.ts`

**Interfaces:**

- Consumes: `tsconfig.base.json` from Task 1; `@glyphquire/shared` for env schema from Task 2
- Produces:
  - `@glyphquire/database`: `createDb(url: string)` returning Drizzle instance; `user`, `session`, `account`, `verification` table definitions and inferred types (`User`, `Session`, `Account`, `Verification`); `runMigrations(url: string)` function; re-exported schema

- [ ] **Step 1: Create `packages/database/package.json`**

```json
{
  "name": "@glyphquire/database",
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
    "build": "tsc",
    "clean": "rm -rf dist",
    "generate": "drizzle-kit generate",
    "migrate": "tsx src/migrate.ts",
    "studio": "drizzle-kit studio"
  },
  "dependencies": {
    "drizzle-orm": "^0.44.0",
    "postgres": "^3.4.0",
    "@glyphquire/shared": "workspace:*"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Create `packages/database/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/database/drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 4: Create `packages/database/src/schema/auth.ts`**

This schema matches Better Auth's expected table structure for PostgreSQL with Drizzle.

```typescript
import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
```

- [ ] **Step 5: Create `packages/database/src/schema/index.ts`**

```typescript
export {
  user,
  session,
  account,
  verification,
  userRelations,
  sessionRelations,
  accountRelations,
} from "./auth.js";
```

- [ ] **Step 6: Create `packages/database/src/client.ts`**

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export function createDb(url: string) {
  const client = postgres(url);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
```

- [ ] **Step 7: Create `packages/database/src/migrate.ts`**

```typescript
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const db = createDb(databaseUrl);

await migrate(db, { migrationsFolder: "./src/migrations" });

console.log("Migrations complete");
process.exit(0);
```

- [ ] **Step 8: Create `packages/database/src/index.ts`**

```typescript
export { createDb, type Database } from "./client.js";
export {
  user,
  session,
  account,
  verification,
  userRelations,
  sessionRelations,
  accountRelations,
} from "./schema/index.js";

export type { InferSelectModel, InferInsertModel } from "drizzle-orm";
```

- [ ] **Step 9: Run install and typecheck**

```bash
pnpm install
pnpm --filter @glyphquire/database typecheck
```

Expected: passes with zero errors.

- [ ] **Step 10: Commit**

```bash
git add packages/database
git commit -m "feat: add database package with Drizzle schema and migrations"
```

---

### Task 4: Package — auth (W4)

**Files:**

- Create: `packages/auth/package.json`
- Create: `packages/auth/tsconfig.json`
- Create: `packages/auth/src/index.ts`
- Create: `packages/auth/src/server.ts`
- Create: `packages/auth/src/client.ts`

**Interfaces:**

- Consumes: `@glyphquire/database` — `createDb()` and Drizzle instance type from Task 3
- Produces:
  - `@glyphquire/auth`: `createAuth(db: Database)` returning Better Auth server instance; `createAuthClient(baseUrl: string)` returning Better Auth client

- [ ] **Step 1: Create `packages/auth/package.json`**

```json
{
  "name": "@glyphquire/auth",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "types": "./src/index.ts"
    },
    "./client": {
      "import": "./src/client.ts",
      "types": "./src/client.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "better-auth": "^1.2.0",
    "@glyphquire/database": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Create `packages/auth/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/auth/src/server.ts`**

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Database } from "@glyphquire/database";

export function createAuth(db: Database, options: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
    }),
    baseURL: options.baseUrl,
    secret: options.secret,
    emailAndPassword: {
      enabled: true,
    },
  });
}

export interface AuthOptions {
  baseUrl: string;
  secret: string;
}

export type Auth = ReturnType<typeof createAuth>;
```

- [ ] **Step 4: Create `packages/auth/src/client.ts`**

```typescript
import { createAuthClient as createBetterAuthClient } from "better-auth/client";

export function createAuthClient(baseUrl: string) {
  return createBetterAuthClient({
    baseURL: baseUrl,
  });
}

export type AuthClient = ReturnType<typeof createAuthClient>;
```

- [ ] **Step 5: Create `packages/auth/src/index.ts`**

```typescript
export { createAuth, type Auth, type AuthOptions } from "./server.js";
```

- [ ] **Step 6: Run install and typecheck**

```bash
pnpm install
pnpm --filter @glyphquire/auth typecheck
```

Expected: passes with zero errors.

- [ ] **Step 7: Commit**

```bash
git add packages/auth
git commit -m "feat: add auth package with Better Auth server and client config"
```

---

### Task 5: App — api (W5)

**Files:**

- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/routes/auth.ts`
- Create: `apps/api/src/middleware/cors.ts`
- Create: `apps/api/src/middleware/error-handler.ts`
- Modify: `packages/api-contract/src/index.ts` — wire up real AppType

**Interfaces:**

- Consumes: `@glyphquire/database` — `createDb()` from Task 3; `@glyphquire/auth` — `createAuth()` from Task 4; `@glyphquire/shared` — env schemas from Task 2
- Produces:
  - Hono API server listening on `API_PORT`
  - `GET /api/health` → `{ status: "ok", timestamp: string }`
  - `ALL /api/auth/*` → Better Auth handler
  - `AppType` exported for Hono RPC client

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@glyphquire/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "hono": "^4.7.0",
    "@hono/node-server": "^1.14.0",
    "zod": "^3.25.0",
    "@glyphquire/database": "workspace:*",
    "@glyphquire/auth": "workspace:*",
    "@glyphquire/shared": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `apps/api/src/env.ts`**

```typescript
import { z } from "zod";
import { databaseEnvSchema, authEnvSchema, appEnvSchema } from "@glyphquire/shared";

const envSchema = databaseEnvSchema.merge(authEnvSchema).merge(appEnvSchema);

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:", result.error.format());
    process.exit(1);
  }
  return result.data;
}
```

- [ ] **Step 4: Create `apps/api/src/routes/health.ts`**

```typescript
import { Hono } from "hono";

export const healthRoutes = new Hono().get("/health", (c) => {
  return c.json({
    status: "ok" as const,
    timestamp: new Date().toISOString(),
  });
});
```

- [ ] **Step 5: Create `apps/api/src/routes/auth.ts`**

```typescript
import { Hono } from "hono";
import type { Auth } from "@glyphquire/auth";

export function createAuthRoutes(auth: Auth) {
  return new Hono().all("/auth/*", (c) => {
    return auth.handler(c.req.raw);
  });
}
```

- [ ] **Step 6: Create `apps/api/src/middleware/cors.ts`**

```typescript
import { cors } from "hono/cors";

export function createCorsMiddleware(origin: string) {
  return cors({
    origin,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });
}
```

- [ ] **Step 7: Create `apps/api/src/middleware/error-handler.ts`**

```typescript
import type { ErrorHandler } from "hono";

export const errorHandler: ErrorHandler = (err, c) => {
  console.error(`[API Error]`, err);

  const status = "status" in err && typeof err.status === "number" ? err.status : 500;

  return c.json(
    {
      error: {
        message: status === 500 ? "Internal Server Error" : err.message,
        code: "code" in err && typeof err.code === "string" ? err.code : "INTERNAL_ERROR",
      },
    },
    { status },
  );
};
```

- [ ] **Step 8: Create `apps/api/src/app.ts`**

```typescript
import { Hono } from "hono";
import { createDb } from "@glyphquire/database";
import { createAuth } from "@glyphquire/auth";
import { healthRoutes } from "./routes/health.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error-handler.js";
import type { Env } from "./env.js";

export function createApp(env: Env) {
  const db = createDb(env.DATABASE_URL);
  const auth = createAuth(db, {
    baseUrl: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
  });

  const app = new Hono()
    .use("*", createCorsMiddleware(env.CORS_ORIGIN))
    .onError(errorHandler)
    .route("/api", healthRoutes)
    .route("/api", createAuthRoutes(auth));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
```

- [ ] **Step 9: Create `apps/api/src/index.ts`**

```typescript
import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { createApp } from "./app.js";

const env = loadEnv();
const app = createApp(env);

serve(
  {
    fetch: app.fetch,
    port: env.API_PORT,
  },
  (info) => {
    console.log(`GlyphQuire API running on http://localhost:${info.port}`);
  },
);
```

- [ ] **Step 10: Update `packages/api-contract/src/index.ts` with real AppType**

```typescript
import { hc } from "hono/client";
import type { AppType } from "../../../apps/api/src/app.js";

export type { AppType };

export function createApiClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
}

export type ApiClient = ReturnType<typeof createApiClient>;
```

- [ ] **Step 11: Run install and typecheck**

```bash
pnpm install
pnpm --filter @glyphquire/api typecheck
pnpm --filter @glyphquire/api-contract typecheck
```

Expected: both pass with zero errors.

- [ ] **Step 12: Commit**

```bash
git add apps/api packages/api-contract/src/index.ts
git commit -m "feat: add Hono API server with health check and auth routes"
```

---

### Task 6: App — web (W6)

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/tsconfig.app.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.ts`
- Create: `apps/web/src/App.vue`
- Create: `apps/web/src/router/index.ts`
- Create: `apps/web/src/stores/index.ts`
- Create: `apps/web/src/layouts/AppLayout.vue`
- Create: `apps/web/src/layouts/AuthLayout.vue`
- Create: `apps/web/src/pages/LoginPage.vue`
- Create: `apps/web/src/pages/RegisterPage.vue`
- Create: `apps/web/src/pages/HomePage.vue`
- Create: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/vite-env.d.ts`
- Create: `apps/web/tailwind.css`
- Create: `apps/web/env.d.ts`

**Interfaces:**

- Consumes: `tsconfig.base.json` from Task 1
- Produces: Vue 3 SPA with routing, Tailwind CSS, placeholder pages, Pinia store setup

Note: This task runs in Wave 1, parallel with Tasks 2 and 7. It does NOT depend on `@glyphquire/api-contract` — the API client import is a placeholder that will be wired after Task 5 merges.

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@glyphquire/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "vue-tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "vue": "^3.5.0",
    "vue-router": "^4.5.0",
    "pinia": "^3.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.0",
    "vite": "^6.3.0",
    "vue-tsc": "^2.2.0",
    "typescript": "^5.8.0",
    "@tailwindcss/vite": "^4.1.0",
    "tailwindcss": "^4.1.0"
  }
}
```

- [ ] **Step 2: Create `apps/web/tsconfig.json`**

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }]
}
```

- [ ] **Step 3: Create `apps/web/tsconfig.app.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "preserve",
    "jsxImportSource": "vue",
    "types": ["vite/client"],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "env.d.ts"]
}
```

- [ ] **Step 4: Create `apps/web/env.d.ts`**

```typescript
/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
```

- [ ] **Step 5: Create `apps/web/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 6: Create `apps/web/tailwind.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 7: Create `apps/web/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-TW">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GlyphQuire</title>
    <link rel="stylesheet" href="/tailwind.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 8: Create `apps/web/src/main.ts`**

```typescript
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router/index.js";

const app = createApp(App);

app.use(createPinia());
app.use(router);

app.mount("#app");
```

- [ ] **Step 9: Create `apps/web/src/App.vue`**

```vue
<template>
  <RouterView />
</template>

<script setup lang="ts">
import { RouterView } from "vue-router";
</script>
```

- [ ] **Step 10: Create `apps/web/src/router/index.ts`**

```typescript
import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      component: () => import("@/layouts/AuthLayout.vue"),
      children: [
        {
          path: "",
          name: "login",
          component: () => import("@/pages/LoginPage.vue"),
        },
      ],
    },
    {
      path: "/register",
      component: () => import("@/layouts/AuthLayout.vue"),
      children: [
        {
          path: "",
          name: "register",
          component: () => import("@/pages/RegisterPage.vue"),
        },
      ],
    },
    {
      path: "/",
      component: () => import("@/layouts/AppLayout.vue"),
      children: [
        {
          path: "",
          name: "home",
          component: () => import("@/pages/HomePage.vue"),
        },
      ],
    },
  ],
});
```

- [ ] **Step 11: Create `apps/web/src/stores/index.ts`**

```typescript
// Pinia store setup — individual stores will be added in later phases.
export {};
```

- [ ] **Step 12: Create `apps/web/src/layouts/AuthLayout.vue`**

```vue
<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50">
    <div class="w-full max-w-md p-8">
      <h1 class="text-2xl font-bold text-center mb-8">GlyphQuire</h1>
      <RouterView />
    </div>
  </div>
</template>

<script setup lang="ts">
import { RouterView } from "vue-router";
</script>
```

- [ ] **Step 13: Create `apps/web/src/layouts/AppLayout.vue`**

```vue
<template>
  <div class="min-h-screen bg-white">
    <header class="border-b border-gray-200 px-6 py-4">
      <h1 class="text-xl font-semibold">GlyphQuire</h1>
    </header>
    <main class="p-6">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { RouterView } from "vue-router";
</script>
```

- [ ] **Step 14: Create `apps/web/src/pages/LoginPage.vue`**

```vue
<template>
  <div class="space-y-6">
    <h2 class="text-xl font-semibold text-center">登入</h2>
    <form class="space-y-4" @submit.prevent>
      <div>
        <label for="email" class="block text-sm font-medium text-gray-700">Email</label>
        <input
          id="email"
          type="email"
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label for="password" class="block text-sm font-medium text-gray-700">密碼</label>
        <input
          id="password"
          type="password"
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
        />
      </div>
      <button
        type="submit"
        class="w-full rounded-md bg-black px-4 py-2 text-white hover:bg-gray-800"
      >
        登入
      </button>
    </form>
    <p class="text-center text-sm text-gray-500">
      還沒有帳號？
      <RouterLink to="/register" class="text-black underline">註冊</RouterLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>
```

- [ ] **Step 15: Create `apps/web/src/pages/RegisterPage.vue`**

```vue
<template>
  <div class="space-y-6">
    <h2 class="text-xl font-semibold text-center">註冊</h2>
    <form class="space-y-4" @submit.prevent>
      <div>
        <label for="name" class="block text-sm font-medium text-gray-700">名稱</label>
        <input
          id="name"
          type="text"
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
          placeholder="你的名字"
        />
      </div>
      <div>
        <label for="email" class="block text-sm font-medium text-gray-700">Email</label>
        <input
          id="email"
          type="email"
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label for="password" class="block text-sm font-medium text-gray-700">密碼</label>
        <input
          id="password"
          type="password"
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
        />
      </div>
      <button
        type="submit"
        class="w-full rounded-md bg-black px-4 py-2 text-white hover:bg-gray-800"
      >
        建立帳號
      </button>
    </form>
    <p class="text-center text-sm text-gray-500">
      已經有帳號？
      <RouterLink to="/login" class="text-black underline">登入</RouterLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>
```

- [ ] **Step 16: Create `apps/web/src/pages/HomePage.vue`**

```vue
<template>
  <div class="max-w-2xl mx-auto py-12 text-center">
    <h2 class="text-2xl font-bold mb-4">歡迎使用 GlyphQuire</h2>
    <p class="text-gray-600">以 Markdown 為核心的可擴充筆記工作空間。</p>
  </div>
</template>
```

- [ ] **Step 17: Create `apps/web/src/lib/api.ts`**

```typescript
// API client — will be wired to @glyphquire/api-contract after Task 5.
// For now, export a placeholder base URL config.

export const API_BASE_URL = "/api";
```

- [ ] **Step 18: Run install and typecheck**

```bash
pnpm install
pnpm --filter @glyphquire/web typecheck
```

Expected: passes with zero errors.

- [ ] **Step 19: Verify dev server starts**

```bash
cd apps/web && pnpm dev &
sleep 3
curl -s http://localhost:5173 | head -5
kill %1
```

Expected: returns HTML containing `<div id="app">`.

- [ ] **Step 20: Commit**

```bash
git add apps/web
git commit -m "feat: add Vue 3 + Vite frontend shell with routing and placeholder pages"
```

---

### Task 7: Docker Compose + CI + Environment Config (W7)

**Files:**

- Create: `docker-compose.yml`
- Create: `.github/workflows/ci.yml`
- Create: `.env.example`
- Create: `infra/docker/.gitkeep`
- Create: `tests/.gitkeep`

**Interfaces:**

- Consumes: root `package.json` scripts from Task 1
- Produces: dev Docker services (postgres:5432, minio:9000/9001); CI workflow; env template

- [ ] **Step 1: Create `docker-compose.yml`**

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
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
  minio_data:
```

- [ ] **Step 2: Create `.env.example`**

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

- [ ] **Step 3: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    name: Typecheck, Lint, Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Lint
        run: pnpm lint

      - name: Build
        run: pnpm build
```

- [ ] **Step 4: Create placeholder directories**

```bash
mkdir -p infra/docker
touch infra/docker/.gitkeep
mkdir -p tests
touch tests/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example .github/workflows/ci.yml infra/docker/.gitkeep tests/.gitkeep
git commit -m "feat: add Docker Compose dev services, CI workflow, and env template"
```

---

### Integration Validation (Main Session)

After all worktree merges are complete, the main session runs final validation:

- [ ] **Step 1: Install all dependencies**

```bash
pnpm install
```

- [ ] **Step 2: Run full workspace typecheck**

```bash
pnpm typecheck
```

Expected: zero errors across all packages and apps.

- [ ] **Step 3: Run lint**

```bash
pnpm lint
```

Expected: zero errors.

- [ ] **Step 4: Run build**

```bash
pnpm build
```

Expected: all packages and apps build successfully.

- [ ] **Step 5: Verify Docker Compose starts**

```bash
docker compose up -d postgres minio
docker compose ps
```

Expected: both services healthy.

- [ ] **Step 6: Clean up Docker**

```bash
docker compose down
```

- [ ] **Step 7: Final commit if any integration fixes were needed**

```bash
git add -A
git status
# Only commit if there are changes
git diff --cached --quiet || git commit -m "fix: integration adjustments after Phase 0 assembly"
```
