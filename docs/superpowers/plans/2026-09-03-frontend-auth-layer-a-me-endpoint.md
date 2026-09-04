# Frontend Auth Layer A — `GET /api/v1/me` Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated `GET /api/v1/me` endpoint returning the caller's own `{ userId, personalWorkspaceId }`, closing the single gap that prevents the frontend from discovering which workspace to open after login.

**Architecture:** A new API contract entry (`meApiContract`) plus a thin Hono route (`createMeRoutes`) that reads the authenticated `actorId` from the existing request context and resolves the caller's personal workspace through the existing `PersonalWorkspaceProvisioner.ensurePersonalWorkspace`. No new database schema, no new service class — it composes existing, tested pieces. This is the first of three layers in the spec; Layers B (frontend session/bootstrap) and C (real editable notes) get their own plans and build on this endpoint's shape.

**Tech Stack:** TypeScript (strict), Zod, Hono, better-auth (existing session middleware), Vitest.

**Spec:** docs/superpowers/specs/2026-09-03-frontend-auth-workspace-bootstrap-design.md (§3 Layer A)

## Global Constraints

- TypeScript strict mode; Zod for all request/response validation.
- Response schema is `.strict()` — no extra fields leak.
- The endpoint returns ONLY the authenticated caller's own identity and workspace; it never accepts or trusts a user/workspace id from the request.
- Authorization is enforced by the existing `/api/v1/*` session middleware chain (unauthenticated requests are already rejected before the handler); the handler adds no new auth bypass.
- Naming: `camelCase` functions/vars, `PascalCase` types, `kebab-case` files. Route factory named `createMeRoutes` to match `createUserPreferenceRoutes` et al.
- Linter is oxlint, formatter oxfmt, test runner vitest. Run `pnpm --filter <pkg> test` / `typecheck`.
- **Plan-level refinement of spec §3:** the `/me` response is `{ userId, personalWorkspaceId }` only — `email` is dropped. Rationale: the request context persists only `actorId` + `session`, not `user.email`; adding email would require touching the shared request-context middleware that every route depends on. The frontend already obtains email from the better-auth client's own `getSession()` in Layer B, so no backend field is needed. This does not change the endpoint's outcome (workspace discovery).

---

### Task 1: `/me` API Contract

**Files:**
- Create: `packages/api-contract/src/me/schemas.ts`
- Create: `packages/api-contract/src/me/schemas.test.ts`
- Modify: `packages/api-contract/src/index.ts` (add `export * from "./me/schemas.js";`)

**Interfaces:**
- Consumes: `opaqueAuthIdSchema` from `../jobs/schemas.js` (existing, re-exported via the contract index) for `userId`; `canonicalUuidSchema` from `../notes/schemas.js` (existing) for `personalWorkspaceId`.
- Produces:
  - `meResultSchema: ZodType<{ userId: string; personalWorkspaceId: string }>` (`.strict()`) — `userId` is an opaque better-auth id (NOT a UUID); `personalWorkspaceId` is a canonical UUID.
  - `type MeResult = z.infer<typeof meResultSchema>`.
  - `meApiContract.getMe = { method: "GET", path: "/api/v1/me", response: meResultSchema }`.

- [ ] **Step 1: Write the failing contract test**

Create `packages/api-contract/src/me/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { meApiContract, meResultSchema } from "./schemas.js";

// A better-auth user id is opaque text, not a UUID.
const opaqueUserId = "usr_2N4kQb8fVxErq7wZ";
const workspaceId = "22222222-2222-4222-8222-222222222222";

describe("meResultSchema", () => {
  it("accepts an opaque userId with a canonical-UUID personalWorkspaceId", () => {
    const parsed = meResultSchema.parse({ userId: opaqueUserId, personalWorkspaceId: workspaceId });
    expect(parsed).toEqual({ userId: opaqueUserId, personalWorkspaceId: workspaceId });
  });

  it("rejects an empty userId", () => {
    expect(() => meResultSchema.parse({ userId: "", personalWorkspaceId: workspaceId })).toThrow();
  });

  it("rejects a non-canonical personalWorkspaceId", () => {
    expect(() =>
      meResultSchema.parse({ userId: opaqueUserId, personalWorkspaceId: "not-a-uuid" }),
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      meResultSchema.parse({ userId: opaqueUserId, personalWorkspaceId: workspaceId, email: "x@y.z" }),
    ).toThrow();
  });

  it("declares the GET /api/v1/me contract", () => {
    expect(meApiContract.getMe.method).toBe("GET");
    expect(meApiContract.getMe.path).toBe("/api/v1/me");
    expect(meApiContract.getMe.response).toBe(meResultSchema);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @glyphquire/api-contract exec vitest run src/me/schemas.test.ts`
Expected: FAIL — cannot resolve `./schemas.js` (module not created yet).

- [ ] **Step 3: Write the contract**

Create `packages/api-contract/src/me/schemas.ts`:

```ts
import { z } from "zod";
import { opaqueAuthIdSchema } from "../jobs/schemas.js";
import { canonicalUuidSchema } from "../notes/schemas.js";

// `userId` is a better-auth user id — an opaque text primary key
// (`user.id = text("id")`), NOT a UUID — so it is validated with the shared
// `opaqueAuthIdSchema` (bounded UTF-8 auth id), the same schema used for
// actor ids elsewhere in the contract. `personalWorkspaceId` IS a UUID
// (`workspaces.id = uuid(...)`), so it keeps `canonicalUuidSchema`.
export const meResultSchema = z
  .object({
    userId: opaqueAuthIdSchema,
    personalWorkspaceId: canonicalUuidSchema,
  })
  .strict();

export type MeResult = z.infer<typeof meResultSchema>;

export const meApiContract = {
  getMe: {
    method: "GET",
    path: "/api/v1/me",
    response: meResultSchema,
  },
} as const;
```

- [ ] **Step 4: Export from the contract index**

In `packages/api-contract/src/index.ts`, add alongside the other `export * from "./<domain>/schemas.js";` lines:

```ts
export * from "./me/schemas.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/api-contract exec vitest run src/me/schemas.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck the package**

Run: `pnpm --filter @glyphquire/api-contract typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api-contract/src/me/schemas.ts packages/api-contract/src/me/schemas.test.ts packages/api-contract/src/index.ts
git commit -m "feat: add /api/v1/me API contract"
```

---

### Task 2: `/me` Route + App Wiring + Integration Test

**Files:**
- Create: `apps/api/src/routes/v1/me.ts`
- Create: `apps/api/src/routes/v1/me.integration.test.ts`
- Modify: `apps/api/src/app.ts` (import `createMeRoutes`; mount `app.route("/api/v1", createMeRoutes(workspaceService))` beside the other v1 routes)

**Interfaces:**
- Consumes:
  - `meResultSchema` from `@glyphquire/api-contract` (Task 1).
  - `PersonalWorkspaceProvisioner` from `../../modules/workspaces/WorkspaceService.js` with `ensurePersonalWorkspace(actorId: string): Promise<{ id: string; name: "Personal"; role: "owner" }>` (existing).
  - `getRequestContext(context).actorId` from `../../middleware/request-context.js` (existing).
  - `SecurityVariables` from `../../middleware/security.js`; `PublicApiError` from `../../middleware/error-handler.js`.
  - `workspaceService` binding already constructed in `createAppRuntime` (app.ts).
- Produces:
  - `createMeRoutes(workspaceService: PersonalWorkspaceProvisioner): Hono` exposing `GET /me`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/routes/v1/me.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import type { PersonalWorkspaceProvisioner } from "../../modules/workspaces/WorkspaceService.js";
import { createErrorHandler, PublicApiError } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import { createMeRoutes } from "./me.js";

const baseUrl = "http://localhost:3000";

// Distinct canonical-UUID workspace ids per actor. `personalWorkspaceId` is a
// real UUID column, so the fake must return schema-valid UUIDs (not `ws-...`),
// while still proving each caller is scoped to its own workspace.
const workspaceForA = "33333333-3333-4333-8333-333333333333";
const workspaceForB = "44444444-4444-4444-8444-444444444444";

class FakeWorkspaceProvisioner implements PersonalWorkspaceProvisioner {
  readonly calls: string[] = [];
  async ensurePersonalWorkspace(actorId: string) {
    this.calls.push(actorId);
    const id =
      actorId === userA
        ? workspaceForA
        : actorId === userB
          ? workspaceForB
          : "00000000-0000-4000-8000-000000000000";
    return { id, name: "Personal" as const, role: "owner" as const };
  }
}

function testAuthMiddleware() {
  return async (context: Context<{ Variables: SecurityVariables }>, next: () => Promise<void>) => {
    const actorId = context.req.header("x-test-actor-id");
    if (!actorId) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    const requestId = randomUUID();
    context.set("requestId", requestId);
    context.set("clientIp", "127.0.0.1");
    context.set("requestContext", { requestId, actorId, session: {} as never });
    await next();
  };
}

function buildApp(service: PersonalWorkspaceProvisioner) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler({ error() {} }))
    .route("/api/v1", createMeRoutes(service));
}

const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("GET /api/v1/me", () => {
  it("returns the authenticated caller's own userId + personalWorkspaceId", async () => {
    const app = buildApp(new FakeWorkspaceProvisioner());
    const response = await app.request(`${baseUrl}/api/v1/me`, {
      headers: { "x-test-actor-id": userA },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: userA, personalWorkspaceId: workspaceForA });
  });

  it("scopes the workspace to each caller (user B never sees user A's)", async () => {
    const app = buildApp(new FakeWorkspaceProvisioner());
    const response = await app.request(`${baseUrl}/api/v1/me`, {
      headers: { "x-test-actor-id": userB },
    });
    expect(await response.json()).toEqual({ userId: userB, personalWorkspaceId: workspaceForB });
  });

  it("rejects an unauthenticated request", async () => {
    const app = buildApp(new FakeWorkspaceProvisioner());
    const response = await app.request(`${baseUrl}/api/v1/me`);
    expect(response.status).toBe(404);
  });

  it("rejects any query string", async () => {
    const app = buildApp(new FakeWorkspaceProvisioner());
    const response = await app.request(`${baseUrl}/api/v1/me?workspaceId=x`, {
      headers: { "x-test-actor-id": userA },
    });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @glyphquire/api exec vitest run src/routes/v1/me.integration.test.ts`
Expected: FAIL — cannot resolve `./me.js` (route not created yet).

- [ ] **Step 3: Write the route**

Create `apps/api/src/routes/v1/me.ts`:

```ts
import { meResultSchema } from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { PersonalWorkspaceProvisioner } from "../../modules/workspaces/WorkspaceService.js";

function requireNoQuery(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    throw new PublicApiError("DOCUMENT_INVALID", 400);
  }
}

export function createMeRoutes(workspaceService: PersonalWorkspaceProvisioner) {
  return new Hono<{ Variables: SecurityVariables }>().get("/me", async (context) => {
    requireNoQuery(context.req.raw);
    const actorId = getRequestContext(context).actorId;
    const workspace = await workspaceService.ensurePersonalWorkspace(actorId);
    const result = meResultSchema.parse({
      userId: actorId,
      personalWorkspaceId: workspace.id,
    });
    return context.json(result, 200);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/api exec vitest run src/routes/v1/me.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Mount the route in the app**

In `apps/api/src/app.ts`:

1. Add the import beside the other v1 route imports (e.g. after `import { createUserPreferenceRoutes } from "./routes/v1/preferences.js";`):

```ts
import { createMeRoutes } from "./routes/v1/me.js";
```

2. Mount it beside the other `app.route("/api/v1", ...)` calls (e.g. right after the `createUserPreferenceRoutes` mount):

```ts
app.route("/api/v1", createMeRoutes(workspaceService));
```

(The `workspaceService` binding already exists in `createAppRuntime`.)

- [ ] **Step 6: Typecheck the api app**

Run: `pnpm --filter @glyphquire/api typecheck`
Expected: no errors.

- [ ] **Step 7: Run the full api unit suite (guards against route-wiring regressions)**

Run: `pnpm --filter @glyphquire/api test`
Expected: PASS, including the new `me.integration.test.ts`.

- [ ] **Step 8: Lint the changed files**

Run: `pnpm exec oxlint apps/api/src/routes/v1/me.ts apps/api/src/routes/v1/me.integration.test.ts apps/api/src/app.ts`
Expected: exit 0, no new issues.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/v1/me.ts apps/api/src/routes/v1/me.integration.test.ts apps/api/src/app.ts
git commit -m "feat: add GET /api/v1/me returning the caller's personal workspace"
```

---

### Task 3: App-Level Guard Lock (real assembled app, DB-gated)

**Why:** The pre-approval security review found (P4) that Task 2's integration test builds its own Hono app with a fake auth middleware, so it proves handler logic but does **not** lock in that the *production* mounting order actually guards `/me`. A future refactor could mis-mount `/me` before the session middleware without failing Task 2's test. This task adds one end-to-end test against the fully-assembled app (`createApp`) that fails if `/me` is ever reachable without a session, and that confirms an authenticated caller gets its own provisioned workspace. (Security finding #2 — redundant idempotent `ensurePersonalWorkspace` call — is dispositioned DEFER: idempotent, no security or correctness difference.)

**Files:**
- Create: `apps/api/src/routes/v1/me.app.integration.test.ts`

**Interfaces:**
- Consumes: `createApp`, `AppType` from `../../app.js`; `createDb`, `Database` from `@glyphquire/database`; the `/me` route wired in Task 2. Requires `TEST_DATABASE_URL` (skips otherwise, matching the repo's other DB-gated integration tests).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the DB-gated end-to-end test**

Create `apps/api/src/routes/v1/me.app.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "@glyphquire/database";
import { createApp, type AppType } from "../../app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const baseUrl = "http://localhost:3000";
const authSecret = "integration-only-secret-at-least-32-characters";

function appEnv(url: string) {
  return {
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: baseUrl,
    API_PORT: 3000,
    WEB_PORT: 5173,
    CORS_ORIGIN: "http://localhost:5173",
  };
}

function registrationRequest(email: string) {
  return new Request(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ name: "New User", email, password: "correct-horse-battery-staple" }),
  });
}

function cookieFrom(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";", 1)[0]!;
}

async function registerActor(app: AppType, db: Database, prefix: string) {
  const email = `${prefix}-${randomUUID()}@example.test`;
  const response = await app.request(registrationRequest(email));
  expect(response.status).toBe(200);
  const cookie = cookieFrom(response);
  const record = await db.query.user.findFirst({
    where: (table, { eq }) => eq(table.email, email),
  });
  if (!record) throw new Error("registered user was not persisted");
  return { userId: record.id, cookie };
}

describeWithPostgres("GET /api/v1/me on the assembled app", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  function freshApp() {
    return createApp(appEnv(databaseUrl!), { db });
  }

  it("rejects an unauthenticated request (guard chain is in front of the route)", async () => {
    const app = freshApp();
    const response = await app.request(`${baseUrl}/api/v1/me`, {
      headers: { origin: baseUrl },
    });
    // The request-context/session middleware rejects with 404 before the handler.
    expect(response.status).toBe(404);
  });

  it("returns the authenticated caller's own userId + provisioned personalWorkspaceId", async () => {
    const app = freshApp();
    const actor = await registerActor(app, db, "me");
    const response = await app.request(`${baseUrl}/api/v1/me`, {
      headers: { origin: baseUrl, cookie: actor.cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { userId: string; personalWorkspaceId: string };
    expect(body.userId).toBe(actor.userId);

    const workspace = await db.query.workspaces.findFirst({
      where: (table, { eq }) => eq(table.personalOwnerId, actor.userId),
    });
    expect(workspace).toBeTruthy();
    expect(body.personalWorkspaceId).toBe(workspace!.id);
    // Response carries exactly the two declared fields, nothing else.
    expect(Object.keys(body).sort()).toEqual(["personalWorkspaceId", "userId"]);
  });
});
```

- [ ] **Step 2: Run the test (with a local database) to verify it passes**

Ensure local backing services are up (`docker compose up -d postgres`) and the split-role test URLs are exported (see repo CLAUDE.md):

```bash
export TEST_MIGRATION_DATABASE_URL=postgresql://glyphquire_migration:glyphquire_migration_dev@localhost:5432/glyphquire_dev
export TEST_DATABASE_URL=postgresql://glyphquire_app:glyphquire_app_dev@localhost:5432/glyphquire_dev
```

Run: `pnpm --filter @glyphquire/api exec vitest run src/routes/v1/me.app.integration.test.ts`
Expected: PASS (2 tests). If `TEST_DATABASE_URL` is unset, the suite is skipped (not failed) — but this task's acceptance requires running it against a live database at least once.

- [ ] **Step 3: Lint the new file**

Run: `pnpm exec oxlint apps/api/src/routes/v1/me.app.integration.test.ts`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/v1/me.app.integration.test.ts
git commit -m "test: lock /api/v1/me behind the assembled app's auth guard"
```

---

## Security Review Dispositions (pre-approval)

Read-only security review verdict: **design sound, no P0–P2**. Dispositions:
- **P4 — test fidelity (production mounting not locked by Task 2's fake-app test):** FIX → Task 3 adds a real-assembled-app test asserting unauthenticated `/me` → 404 and authenticated → own provisioned workspace.
- **P4 — redundant idempotent `ensurePersonalWorkspace` call + error-path style inconsistency:** DEFER → idempotent, no security or correctness difference; the handler call is required for the return value.

## Plan-Verifier Readiness Revisions (epoch 2)

The first readiness pass returned REVISE with two P0 correctness blockers, both fixed here:
- **`userId` schema mismatch:** better-auth `user.id` is opaque text (`text("id")`), not a UUID, so `userId: canonicalUuidSchema` would 503 every real call. Fixed → `userId: opaqueAuthIdSchema` (the shared bounded auth-id schema). `personalWorkspaceId` stays `canonicalUuidSchema` because `workspaces.id` IS a `uuid` column.
- **Task 2 fake fixture invalid under the schema:** the fake returned `ws-${actorId}`, which fails `canonicalUuidSchema` for `personalWorkspaceId`. Fixed → the fake returns distinct canonical-UUID workspace ids per actor, and the assertions expect those UUIDs.

Task 3 needed no change: it reads the real `user.id` and `workspaces.id` from the database, which already have the correct shapes.

## Notes for the Reviewer / Verifier

- The security property "a user cannot read another user's workspace" holds structurally: the handler never reads a workspace/user id from the request — it uses only the authenticated `actorId` and resolves that actor's own workspace. The integration test asserts each caller gets its own id and that an unauthenticated request is rejected.
- The endpoint runs inside the existing `/api/v1/*` middleware chain (client-IP, request-security, rate limiter, request-context/session, `ensurePersonalWorkspace`). Mounting order beside the other v1 routes keeps it under that chain.
- No database migration and no new service: `ensurePersonalWorkspace` is idempotent and already invoked by the v1 middleware, so calling it in the handler is consistent and cheap.
