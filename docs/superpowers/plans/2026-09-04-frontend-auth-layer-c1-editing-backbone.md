# Frontend Auth Layer C-1 — Editing Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing (but unused-in-production) editing machinery into a real, authenticated `WorkbenchSessionFactory` so that a signed-in user opening a note gets a live `EditorSession` backed by the real note content, note lock, session-lifecycle coordinator, local draft store, and autosave — the backbone the Explorer (C-2) and recent-notes (C-3) slices build on.

**Architecture:** Three composable pieces. (1) The session store learns the session's `expiresAt` (needed by the lifecycle coordinator), sourced from better-auth's `getSession()`. (2) A `createWorkbenchSessionFactory` builder wires `openEditorSession` for one authenticated session — it owns a single app-scoped `BrowserSessionLifecycleCoordinator` + `IndexedDbDraftStore` + `NoteClient`, and per opened note loads content via `NoteClient.getNote` then constructs a `NoteLock` and calls `openEditorSession`. `openEditorSession` is injected (defaulting to the real one) so the builder is unit-testable with a fake. (3) A `useProductionWorkbenchHost` composable, called from the workbench route, provides that factory via the existing `provideAuthenticatedWorkbenchHost` bridge, gated on the session store being authenticated, and wires sign-out.

**Tech Stack:** Vue 3 (`<script setup>` / composables), Pinia, better-auth/client (via `@glyphquire/auth/client`), Vitest, `@vue/test-utils`, fake-indexeddb.

**Spec:** docs/superpowers/specs/2026-09-03-frontend-auth-workspace-bootstrap-design.md (§5.1). Prerequisites — Layer A (`GET /api/v1/me`), Layer B (session store + guard), and Layer C-0 (opaque userId through the coordination path) — are all implemented and independently verified.

## Global Constraints

- Ports-and-adapters: `createWorkbenchSessionFactory` depends on injected seams (`openSession`, a `NoteReader` with `getNote`, a `NoteLock` constructor) so it is unit-testable without a live backend or the full editor stack; production defaults wire the real implementations.
- No session token/cookie value stored in JS/Pinia/localStorage — the store adds only a non-secret `sessionExpiresAt: number | null` (epoch ms).
- `userId` is opaque (Layer C-0 made the coordination path accept it); `workspaceId`/`noteId` are canonical UUIDs. `NoteScope` = `{ userId, workspaceId, noteId }`.
- The lifecycle coordinator is created once per authenticated session (not per note) and disposed on sign-out; every note's `EditorSession` shares it.
- No changes to `EditorSession.ts`, `NoteLock.ts`, `SessionLifecycleCoordinator.ts`, `DraftStore.ts`, or `DocumentWorkerClient.ts` internals — this slice only composes them.
- Linter oxlint, formatter oxfmt, tests vitest. Web tests: `pnpm --filter @glyphquire/web exec vitest run <file>`.

---

### Task 1: Session Store Learns `expiresAt`

**Files:**
- Modify: `apps/web/src/auth/AuthGateway.ts` (add `expiresAt` to `AuthIdentity`)
- Modify: `apps/web/src/auth/BetterAuthGateway.ts` (`currentIdentity` reads `data.session.expiresAt`)
- Modify: `apps/web/src/auth/BetterAuthGateway.test.ts` (assert expiresAt mapping)
- Modify: `apps/web/src/stores/session.ts` (hold `sessionExpiresAt`)
- Modify: `apps/web/src/stores/session.test.ts` (assert it is populated)

**Interfaces:**
- Consumes: better-auth `getSession()` → `{ data: { user, session: { expiresAt: Date } } | null }`.
- Produces:
  - `AuthIdentity` gains `readonly expiresAt: number` (epoch ms).
  - `useSessionStore` gains `sessionExpiresAt: Ref<number | null>`, set during `bootstrap()` from the identity and cleared by `clearIdentity()`.

- [ ] **Step 1: Update the adapter test to expect expiresAt**

In `apps/web/src/auth/BetterAuthGateway.test.ts`, update the `fakeAuthClient` default `getSession` and the `currentIdentity` mapping test. Replace the existing `"currentIdentity maps a live session to { userId, email }"` test and the fake's `getSession` line so a session carries `expiresAt`:

```ts
it("currentIdentity maps a live session to { userId, email, expiresAt }", async () => {
  const expires = new Date("2030-01-01T00:00:00.000Z");
  const gw = new BetterAuthGateway(
    fakeAuthClient({
      getSession: async () => ({
        data: { user: { id: "usr_1", email: "a@b.co" }, session: { expiresAt: expires } },
        error: null,
      }),
    }),
  );
  expect(await gw.currentIdentity()).toEqual({
    userId: "usr_1",
    email: "a@b.co",
    expiresAt: expires.getTime(),
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/auth/BetterAuthGateway.test.ts`
Expected: FAIL — `currentIdentity` does not yet return `expiresAt`.

- [ ] **Step 3: Add `expiresAt` to the port and adapter**

In `apps/web/src/auth/AuthGateway.ts`, add the field:

```ts
export interface AuthIdentity {
  readonly userId: string;
  readonly email: string;
  readonly expiresAt: number;
}
```

In `apps/web/src/auth/BetterAuthGateway.ts`, update `currentIdentity` to read the session expiry. better-auth's `session.expiresAt` is a `Date` in-process, but the client transport can deserialize it as an ISO string (or, defensively, a number); accept all three and normalize to epoch ms, returning `null` only when it is genuinely absent/unparseable (fail-closed, but not fail-closed on a mere serialization difference — that would wrongly log every user out):

```ts
function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
```

```ts
  async currentIdentity(): Promise<AuthIdentity | null> {
    const { data } = await this.client.getSession();
    const user = data?.user;
    const expiresAt = toEpochMs(data?.session?.expiresAt);
    if (!user?.id || typeof user.email !== "string" || expiresAt === null || expiresAt <= 0) {
      return null;
    }
    return { userId: user.id, email: user.email, expiresAt };
  }
```

- [ ] **Step 4: Run the adapter test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/auth/BetterAuthGateway.test.ts`
Expected: PASS (4 tests). If the real better-auth client types don't type `data.session.expiresAt` as a `Date`, adjust only the access/narrowing in the adapter (not the port); the Step 6 typecheck is the gate.

- [ ] **Step 5: Populate `sessionExpiresAt` in the store**

In `apps/web/src/stores/session.ts`:

1. Add the ref beside the others: `const sessionExpiresAt = ref<number | null>(null);`
2. In `clearIdentity()`, add: `sessionExpiresAt.value = null;`
3. In `bootstrap()`, in the success branch (after `personalWorkspaceId.value = meResult.personalWorkspaceId;`), add: `sessionExpiresAt.value = identity.expiresAt;`
4. Add `sessionExpiresAt` to the returned object.

Then extend the store test — in `apps/web/src/stores/session.test.ts`, update the `FakeAuth`'s `identity` constant to include `expiresAt` and assert the store exposes it. Change the shared `identity` fixture:

```ts
const identity: AuthIdentity = { userId: "usr_1", email: "a@b.co", expiresAt: 1893456000000 };
```

and add to the `"restore resolves to authenticated and loads the workspace when a session exists"` test:

```ts
expect(store.sessionExpiresAt).toBe(1893456000000);
```

- [ ] **Step 6: Run the store test + typecheck**

Run: `pnpm --filter @glyphquire/web exec vitest run src/stores/session.test.ts src/auth/BetterAuthGateway.test.ts`
Run: `pnpm --filter @glyphquire/web typecheck`
Expected: PASS; typecheck clean (this confirms the adapter matches the real better-auth session type).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/auth/AuthGateway.ts apps/web/src/auth/BetterAuthGateway.ts apps/web/src/auth/BetterAuthGateway.test.ts apps/web/src/stores/session.ts apps/web/src/stores/session.test.ts
git commit -m "feat: expose session expiresAt from the session store"
```

---

### Task 2: `createWorkbenchSessionFactory` Builder

**Files:**
- Create: `apps/web/src/providers/workbenchSessionFactory.ts`
- Create: `apps/web/src/providers/workbenchSessionFactory.test.ts`

**Interfaces:**
- Consumes:
  - `WorkbenchSessionFactory`, `WorkbenchSessionHandle`, `WorkbenchNote` from `../components/workbench/types.js`.
  - `openEditorSession` + `EditorSessionDeps` from `../editors/EditorSession.js` / `../editors/editor-session.types.js`.
  - `NoteLock` from `../coordination/NoteLock.js`; `BrowserSessionLifecycleCoordinator` from `../coordination/SessionLifecycleCoordinator.js`; `IndexedDbDraftStore` from `../persistence/DraftStore.js`; `DocumentWorkerClient` from `../editors/DocumentWorkerClient.js`; `NoteClient` from `../api/NoteClient.js`.
  - `EditorSession` from `../editors/editor-session.types.js`.
- Produces:
  - `interface NoteReader { getNote(noteId: string): Promise<{ contentMarkdown: string; revision: number }> }` (NoteClient satisfies this).
  - `interface WorkbenchSessionFactoryDeps` — the injectable seams (see code).
  - `function createWorkbenchSessionFactory(config: WorkbenchSessionFactoryConfig, deps?: Partial<WorkbenchSessionFactoryDeps>): WorkbenchSessionFactory`.

- [ ] **Step 1: Write the failing unit test (with fakes for every seam)**

Create `apps/web/src/providers/workbenchSessionFactory.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createWorkbenchSessionFactory } from "./workbenchSessionFactory.js";
import type { EditorSession } from "../editors/editor-session.types.js";
import type { WorkbenchNote } from "../components/workbench/types.js";

const userId = "usr_2N4kQb8fVxErq7wZ";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const noteId = "44444444-4444-4444-8444-444444444444";

const config = {
  userId,
  workspaceId,
  workspaceName: "Personal",
  accountLabel: "a@b.co",
};

function fakeNote(): WorkbenchNote {
  return { id: noteId, title: "My note", markdown: "" };
}

describe("createWorkbenchSessionFactory", () => {
  it("loads the note content and opens a session with correctly wired deps", async () => {
    const fakeSession = { dispose: async () => undefined } as unknown as EditorSession;
    const openSession = vi.fn(async () => fakeSession);
    const getNote = vi.fn(async () => ({ contentMarkdown: "# Hello", revision: 7 }));
    const makeLock = vi.fn((scope) => ({ scope }) as never);

    const factory = createWorkbenchSessionFactory(config, {
      openSession,
      noteReader: { getNote },
      lifecycle: {} as never,
      draftStore: {} as never,
      documentAnalysis: {} as never,
      makeLock,
    });

    const handle = (await factory(fakeNote())) as { session: EditorSession; context: unknown };
    expect(getNote).toHaveBeenCalledWith(noteId);
    // Lock scope is the full tenant/note identity.
    expect(makeLock).toHaveBeenCalledWith({ userId, workspaceId, noteId });
    // openSession receives the authoritative content + identity.
    const deps = openSession.mock.calls[0]![0];
    expect(deps.userId).toBe(userId);
    expect(deps.workspaceId).toBe(workspaceId);
    expect(deps.noteId).toBe(noteId);
    expect(deps.initialMarkdown).toBe("# Hello");
    expect(deps.initialRevision).toBe(7);
    expect(handle.session).toBe(fakeSession);
    expect(handle.context).toEqual({ userId, workspaceId, workspaceName: "Personal", accountLabel: "a@b.co" });
  });

  it("propagates a getNote failure (the workbench context handles a rejected factory)", async () => {
    const factory = createWorkbenchSessionFactory(config, {
      openSession: vi.fn(),
      noteReader: { getNote: vi.fn(async () => { throw new Error("offline"); }) },
      lifecycle: {} as never,
      draftStore: {} as never,
      documentAnalysis: {} as never,
      makeLock: vi.fn(),
    });
    await expect(factory(fakeNote())).rejects.toThrow("offline");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/providers/workbenchSessionFactory.test.ts`
Expected: FAIL — cannot resolve `./workbenchSessionFactory.js`.

- [ ] **Step 3: Write the builder**

Create `apps/web/src/providers/workbenchSessionFactory.ts`:

```ts
import { NoteClient } from "../api/NoteClient.js";
import { NoteLock } from "../coordination/NoteLock.js";
import type { NoteScope } from "../coordination/TabChannel.js";
import type { EditorSessionLifecycle } from "../coordination/SessionLifecycleCoordinator.js";
import { IndexedDbDraftStore } from "../persistence/DraftStore.js";
import { DocumentWorkerClient } from "../editors/DocumentWorkerClient.js";
import { openEditorSession } from "../editors/EditorSession.js";
import type {
  DocumentAnalysisPort,
  DraftStore,
  EditorSession,
  EditorSessionDeps,
  NoteLockLike,
  NoteRemote,
} from "../editors/editor-session.types.js";
import type {
  WorkbenchNote,
  WorkbenchSessionFactory,
  WorkbenchSessionHandle,
} from "../components/workbench/types.js";

/** The narrow read the factory needs to load authoritative note content. */
export interface NoteReader {
  getNote(noteId: string): Promise<{ contentMarkdown: string; revision: number }>;
}

export interface WorkbenchSessionFactoryConfig {
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly accountLabel?: string;
}

/** Injectable seams — production defaults wire the real implementations. */
export interface WorkbenchSessionFactoryDeps {
  openSession: (deps: EditorSessionDeps) => Promise<EditorSession>;
  noteReader: NoteReader;
  noteRemote: NoteRemote;
  lifecycle: EditorSessionLifecycle;
  draftStore: DraftStore;
  documentAnalysis: DocumentAnalysisPort;
  makeLock: (scope: NoteScope) => NoteLockLike;
}

function defaultDeps(): Pick<
  WorkbenchSessionFactoryDeps,
  "openSession" | "noteReader" | "noteRemote" | "documentAnalysis" | "makeLock"
> {
  const client = new NoteClient();
  return {
    openSession: openEditorSession,
    noteReader: client,
    noteRemote: client,
    documentAnalysis: new DocumentWorkerClient(),
    makeLock: (scope) => new NoteLock(scope),
  };
}

/**
 * Builds one authenticated session factory. `lifecycle` and `draftStore` are
 * owned by the caller (one per authenticated session, shared across notes);
 * everything else defaults to the real implementation but is injectable for tests.
 */
export function createWorkbenchSessionFactory(
  config: WorkbenchSessionFactoryConfig,
  deps: Partial<WorkbenchSessionFactoryDeps> & Pick<WorkbenchSessionFactoryDeps, "lifecycle" | "draftStore">,
): WorkbenchSessionFactory {
  const defaults = defaultDeps();
  const openSession = deps.openSession ?? defaults.openSession;
  const noteReader = deps.noteReader ?? defaults.noteReader;
  const noteRemote = deps.noteRemote ?? defaults.noteRemote;
  const documentAnalysis = deps.documentAnalysis ?? defaults.documentAnalysis;
  const makeLock = deps.makeLock ?? defaults.makeLock;
  const { lifecycle, draftStore } = deps;

  return async (note: Readonly<WorkbenchNote>): Promise<WorkbenchSessionHandle> => {
    const loaded = await noteReader.getNote(note.id);
    const scope: NoteScope = {
      userId: config.userId,
      workspaceId: config.workspaceId,
      noteId: note.id,
    };
    const session = await openSession({
      userId: config.userId,
      workspaceId: config.workspaceId,
      noteId: note.id,
      initialRevision: loaded.revision,
      initialMarkdown: loaded.contentMarkdown,
      noteClient: noteRemote,
      draftStore,
      noteLock: makeLock(scope),
      sessionLifecycle: lifecycle,
      documentAnalysis,
    });
    return {
      session,
      context: {
        userId: config.userId,
        workspaceId: config.workspaceId,
        ...(config.workspaceName === undefined ? {} : { workspaceName: config.workspaceName }),
        ...(config.accountLabel === undefined ? {} : { accountLabel: config.accountLabel }),
      },
    };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/providers/workbenchSessionFactory.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck (locks the deps against the real `openEditorSession`/`EditorSessionDeps` types)**

Run: `pnpm --filter @glyphquire/web typecheck`
Expected: no errors. If `openEditorSession`'s real signature or `EditorSessionDeps` differs from the wiring above (e.g. an extra required field), fix the builder's deps object here to satisfy the real type — do not change the injectable-seam shape.

- [ ] **Step 6: Lint + commit**

Run: `pnpm exec oxlint apps/web/src/providers/workbenchSessionFactory.ts apps/web/src/providers/workbenchSessionFactory.test.ts`

```bash
git add apps/web/src/providers/workbenchSessionFactory.ts apps/web/src/providers/workbenchSessionFactory.test.ts
git commit -m "feat: add production workbench session factory builder"
```

---

### Task 3: `useProductionWorkbenchHost` Composable + Route Wiring

**Files:**
- Create: `apps/web/src/providers/useProductionWorkbenchHost.ts`
- Create: `apps/web/src/providers/useProductionWorkbenchHost.test.ts`
- Modify: `apps/web/src/pages/WorkbenchPage.vue` (call the composable)

**Interfaces:**
- Consumes: `useSessionStore` (Task 1), `createWorkbenchSessionFactory` (Task 2), `provideAuthenticatedWorkbenchHost` from `./AuthenticatedWorkbenchHost.js`, `BrowserSessionLifecycleCoordinator`, `IndexedDbDraftStore`.
- Produces: `function useProductionWorkbenchHost(deps?: ProductionWorkbenchHostDeps): WorkbenchHostContext | null` — when the session store is `authenticated` with a `personalWorkspaceId` + a positive `sessionExpiresAt`, it creates one shared `IndexedDbDraftStore` + `BrowserSessionLifecycleCoordinator({ initialSession: { userId, expiresAt, workspaceIds: [workspaceId] }, draftStore })` (both via injectable `deps`, defaulting to the real ones), builds a factory via `createWorkbenchSessionFactory`, calls `provideAuthenticatedWorkbenchHost(...)`, and RETURNS the resulting `WorkbenchHostContext`. `onAccountAction("sign-out")` routes through `lifecycle.logout(() => session.signOut())` (local draft/lock scrub + scoped logout broadcast, then network sign-out + store clear). On unmount it disposes the coordinator. When not authenticated it returns `null` (the guard has already redirected). **The caller must use the RETURNED context — not re-inject it via `useWorkbenchHostContext()` — because Vue's `inject` never sees the current component's own `provide`.**
- Also exports `interface SessionCoordinatorLike` and `interface ProductionWorkbenchHostDeps` (the injectable seams).

- [ ] **Step 1: Write the failing composable test**

Create `apps/web/src/providers/useProductionWorkbenchHost.test.ts`:

The composable RETURNS the context (it cannot be re-injected in the same component), so the probe exposes the return value and the sign-out handler taken from it — no `useWorkbenchHostContext()`.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import {
  useProductionWorkbenchHost,
  type ProductionWorkbenchHostDeps,
  type SessionCoordinatorLike,
} from "./useProductionWorkbenchHost.js";
import type { WorkbenchHostContext } from "../components/workbench/WorkbenchContext.js";
import { useSessionStore } from "../stores/session.js";

const userId = "usr_2N4kQb8fVxErq7wZ";
const workspaceId = "22222222-2222-4222-8222-222222222222";

function fakeCoordinator(): SessionCoordinatorLike {
  return {
    authorizeEditor: vi.fn(async () => undefined),
    assertEditorAuthorized: vi.fn(),
    registerEditor: vi.fn(() => () => undefined),
    logout: vi.fn(async (networkLogout: () => Promise<void>) => {
      await networkLogout();
    }),
    dispose: vi.fn(),
  };
}

// Captures the composable's RETURN value for assertions.
let captured: WorkbenchHostContext | null = null;

function probeWith(deps: ProductionWorkbenchHostDeps) {
  return defineComponent({
    setup() {
      captured = useProductionWorkbenchHost(deps);
      return () =>
        h("output", {
          "data-has-factory": captured?.sessionFactory ? "yes" : "no",
          "data-ws": captured?.workspaceId ?? "",
          onClick: () => captured?.onAccountAction?.("sign-out"),
        });
    },
  });
}

function authenticatedStore() {
  const store = useSessionStore();
  store.status = "authenticated";
  store.userId = userId;
  store.personalWorkspaceId = workspaceId;
  store.email = "a@b.co";
  store.sessionExpiresAt = 1893456000000;
  return store;
}

describe("useProductionWorkbenchHost", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    captured = null;
  });

  it("returns a real host context with a session factory when authenticated", () => {
    authenticatedStore();
    const coordinator = fakeCoordinator();
    const deps: ProductionWorkbenchHostDeps = {
      createDraftStore: () => ({}) as never,
      createLifecycle: () => coordinator,
    };
    const wrapper = mount(probeWith(deps));
    expect(captured?.sessionFactory).toBeTypeOf("function");
    expect(captured?.workspaceId).toBe(workspaceId);
    expect(wrapper.get("output").attributes("data-has-factory")).toBe("yes");
    wrapper.unmount();
    expect(coordinator.dispose).toHaveBeenCalledOnce();
  });

  it("routes sign-out through the coordinator's logout (local scrub) then network sign-out", async () => {
    const store = authenticatedStore();
    store.signOut = vi.fn(async () => undefined);
    const coordinator = fakeCoordinator();
    const deps: ProductionWorkbenchHostDeps = {
      createDraftStore: () => ({}) as never,
      createLifecycle: () => coordinator,
    };
    const wrapper = mount(probeWith(deps));
    await wrapper.get("output").trigger("click");
    await Promise.resolve();
    expect(coordinator.logout).toHaveBeenCalledOnce();
    // The logout networkLogout callback is the store sign-out.
    expect(store.signOut).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("returns null when the session is not authenticated", () => {
    const store = useSessionStore();
    store.status = "anonymous";
    const deps: ProductionWorkbenchHostDeps = {
      createDraftStore: () => ({}) as never,
      createLifecycle: () => fakeCoordinator(),
    };
    const wrapper = mount(probeWith(deps));
    expect(captured).toBeNull();
    expect(wrapper.get("output").attributes("data-has-factory")).toBe("no");
    wrapper.unmount();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/providers/useProductionWorkbenchHost.test.ts`
Expected: FAIL — cannot resolve `./useProductionWorkbenchHost.js`.

- [ ] **Step 3: Write the composable**

Create `apps/web/src/providers/useProductionWorkbenchHost.ts`:

```ts
import { onBeforeUnmount } from "vue";
import { BrowserSessionLifecycleCoordinator } from "../coordination/SessionLifecycleCoordinator.js";
import type { EditorSessionLifecycle } from "../coordination/SessionLifecycleCoordinator.js";
import { IndexedDbDraftStore } from "../persistence/DraftStore.js";
import type { DraftStore } from "../editors/editor-session.types.js";
import { useSessionStore } from "../stores/session.js";
import { provideAuthenticatedWorkbenchHost } from "./AuthenticatedWorkbenchHost.js";
import { createWorkbenchSessionFactory } from "./workbenchSessionFactory.js";
import type {
  WorkbenchAccountAction,
  WorkbenchHostContext,
} from "../components/workbench/WorkbenchContext.js";

/**
 * The coordinator surface this composable needs: the `EditorSessionLifecycle`
 * the factory consumes, plus `logout` (local-draft scrub + scoped cross-tab
 * logout broadcast, run before the network sign-out) and `dispose`.
 */
export interface SessionCoordinatorLike extends EditorSessionLifecycle {
  logout(networkLogout: () => Promise<void>): Promise<void>;
  dispose(): void;
}

/** Injectable seams for tests; production builds the real coordinator + store. */
export interface ProductionWorkbenchHostDeps {
  createDraftStore: () => DraftStore;
  createLifecycle: (
    session: { userId: string; expiresAt: number; workspaceIds: string[] },
    draftStore: DraftStore,
  ) => SessionCoordinatorLike;
}

function defaultHostDeps(): ProductionWorkbenchHostDeps {
  return {
    createDraftStore: () => new IndexedDbDraftStore(),
    createLifecycle: (initialSession, draftStore) =>
      new BrowserSessionLifecycleCoordinator({ initialSession, draftStore }),
  };
}

/**
 * Provides the authenticated workbench host (real session factory) for the
 * current signed-in session. No-op when the session store is not authenticated
 * (the router guard has already redirected an anonymous user to /login). The
 * lifecycle coordinator + draft store are created once here and shared across
 * every note session opened during this mount; both are torn down on unmount.
 *
 * Sign-out is routed through the coordinator's `logout(...)` so the departing
 * user's local drafts are scrubbed and a scoped cross-tab logout is broadcast
 * BEFORE the network sign-out — `dispose()` alone does not do this.
 */
export function useProductionWorkbenchHost(
  deps: ProductionWorkbenchHostDeps = defaultHostDeps(),
): WorkbenchHostContext | null {
  const session = useSessionStore();
  const userId = session.userId;
  const workspaceId = session.personalWorkspaceId;
  const expiresAt = session.sessionExpiresAt;

  if (
    session.status !== "authenticated" ||
    !userId ||
    !workspaceId ||
    expiresAt === null ||
    expiresAt <= 0
  ) {
    return null;
  }

  const draftStore = deps.createDraftStore();
  const lifecycle = deps.createLifecycle(
    { userId, expiresAt, workspaceIds: [workspaceId] },
    draftStore,
  );

  const sessionFactory = createWorkbenchSessionFactory(
    {
      userId,
      workspaceId,
      workspaceName: "Personal",
      ...(session.email ? { accountLabel: session.email } : {}),
    },
    { lifecycle, draftStore },
  );

  const onAccountAction = (action: WorkbenchAccountAction): void => {
    if (action !== "sign-out") return;
    // Local scrub (drafts + locks + scoped logout broadcast) THEN network sign-out;
    // session.signOut() also clears the Pinia store in its own finally.
    void lifecycle.logout(() => session.signOut()).catch(() => undefined);
  };

  // Also provide it (for any descendant that injects), but the caller uses the
  // RETURNED context directly — Vue's `inject` never sees the current
  // component's own `provide`, so the consumer must not re-inject this.
  const context = provideAuthenticatedWorkbenchHost({
    userId,
    workspaceId,
    workspaceName: "Personal",
    ...(session.email ? { accountLabel: session.email } : {}),
    sessionFactory,
    onAccountAction,
  });

  onBeforeUnmount(() => {
    lifecycle.dispose();
  });

  return context;
}
```

- [ ] **Step 4: Run the composable test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/providers/useProductionWorkbenchHost.test.ts`
Expected: PASS (3 tests). Note: `provideAuthenticatedWorkbenchHost` calls Vue's `provide`, which requires an active component `setup()` — the probe component provides that context. The tests inject a fake coordinator via `deps`, so no real `BrowserSessionLifecycleCoordinator`/IndexedDB is constructed; the "authenticated" test also asserts `dispose()` runs on unmount, and the sign-out test asserts `logout()` is called and its callback invokes `session.signOut`.

- [ ] **Step 5: Consume the composable's RETURNED context in the workbench route**

In `apps/web/src/pages/WorkbenchPage.vue`, use the composable's return value as the host context, falling back to the injected context (AppLayout's empty `{}`, or a test's explicit props) only when not authenticated. Add the import:

```ts
import { useProductionWorkbenchHost } from "../providers/useProductionWorkbenchHost.js";
```

and replace the existing line

```ts
const hostContext = useWorkbenchHostContext();
```

with

```ts
const productionHost = useProductionWorkbenchHost();
const hostContext = productionHost ?? useWorkbenchHostContext();
```

Everything downstream (`sessionFactory` computed = `props.sessionFactory ?? hostContext.sessionFactory`, the `:workspace-id`/`:workspace-name`/`:account-label` bindings, and `forwardAccountAction`) is unchanged — it now reads the production context when authenticated. This does NOT re-inject the composable's own provide (which Vue would not see); it uses the returned value directly. The existing `WorkbenchPage.test.ts` path is unaffected: it provides its own non-authenticated pinia, so `productionHost` is `null`, `hostContext` falls back to the injected context, and the explicit `sessionFactory` prop still wins in the computed.

- [ ] **Step 6: Typecheck + lint + the affected page/provider suites**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/providers/useProductionWorkbenchHost.ts apps/web/src/providers/useProductionWorkbenchHost.test.ts apps/web/src/pages/WorkbenchPage.vue`
Run: `pnpm --filter @glyphquire/web exec vitest run src/pages/WorkbenchPage.test.ts src/providers`
Expected: clean; `WorkbenchPage.test.ts` still passes (it passes an explicit `sessionFactory` prop, and provides its own pinia; when its store is not authenticated the composable is a no-op and the existing prop-driven path is unchanged).

- [ ] **Step 7: Full web suite (regression guard)**

Run: `pnpm --filter @glyphquire/web test`
Expected: PASS, full suite green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/providers/useProductionWorkbenchHost.ts apps/web/src/providers/useProductionWorkbenchHost.test.ts apps/web/src/pages/WorkbenchPage.vue
git commit -m "feat: provide the authenticated workbench host for signed-in sessions"
```

---

## Plan-Verifier Readiness Revision (epoch 2)

The first readiness pass returned REVISE with one load-bearing blocker: Task 3 relied on `provide` + `inject` of the same key in the SAME component's setup (the composable provided the host, and WorkbenchPage/​the probe re-injected it via `useWorkbenchHostContext()`). Vue's `inject` resolves against ancestors, never the current component's own `provide`, so the production factory would never reach the consumer (WorkbenchPage would keep seeing AppLayout's empty `{}`), and the Task 3 tests would fail. Fixed: `useProductionWorkbenchHost` now RETURNS the built `WorkbenchHostContext` (in addition to still calling `provide` for any descendant), and both WorkbenchPage (Step 5) and the test (Step 1) consume the RETURNED value directly instead of re-injecting. Type/signature wiring for Tasks 1–2 was confirmed correct by that same pass and is unchanged.

## Security Review Dispositions (pre-approval)

Read-only security review verdict: **tenant/secret/injection surface sound, no P0/P1**. Dispositions:
- **P2 — sign-out left local drafts behind and skipped the cross-tab scoped-logout broadcast** (the composable called only `session.signOut()` + bare `dispose()`, but `dispose()` does not scrub drafts/locks or broadcast; the coordinator's purpose-built `logout()`→`endUserLocally` path was unwired, so spec §6 "Sign-out clears session state and local session-scoped caches" was unmet): FIX → `onAccountAction("sign-out")` now routes through `lifecycle.logout(() => session.signOut())`; a new test asserts this wiring. This also resolves the related **P3 stale local write-authorization window** (the same root cause — `logout()` ends the session locally so `assertEditorAuthorized` stops returning true).
- **P3 — `expiresAt instanceof Date` narrowing would fail-close every login if the client transport serializes the session date as a string:** FIX → the adapter now accepts `Date | string | number` via `toEpochMs` and only returns `null` when genuinely absent/unparseable.
- **P4 — composable guarded `expiresAt === null` but not a non-positive value:** FIX → guard now also rejects `expiresAt <= 0`, so a `0`/negative epoch is a clean no-op rather than a coordinator-constructor throw.

## Notes for the Reviewer / Verifier

- This slice makes a real note openable/editable but does NOT yet replace the workbench's demo note LIST — that is Layer C-2 (Explorer wired to `useNotesStore`). Until C-2, the production factory is provided but the note list the user sees still comes from `WorkbenchContext`'s defaults; C-1's deliverable is that the factory + lifecycle + host wiring are correct and unit-verified, so C-2 can source real note ids and open them.
- **Manual end-to-end check (verifier, with backing services + web dev server):** sign in, then open a note whose id exists in the user's workspace (e.g. via a temporary direct `?noteId=` once C-2 lands, or by unit-level confidence here) → an editable session loads the real content and autosaves. C-1's automated proof is the unit tests; the live end-to-end is exercised once C-2 provides the real note list.
- **Security:** no token stored; `sessionExpiresAt` is a non-secret epoch number. The lifecycle coordinator's `expiresAt` drives local session-expiry only; server-side auth remains the boundary. The opaque `userId` flows through `NoteScope`/`liveBrowserSessionSchema`, which Layer C-0 verified accept it.
- **Coordinator lifetime:** created per authenticated mount of the workbench route and disposed on unmount; a future account switch re-mounts the route (guard redirect) and rebuilds it. Multiple concurrent coordinators are not created because the composable returns early unless authenticated and the route mounts once.
