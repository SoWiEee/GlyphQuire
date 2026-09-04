# Frontend Auth Layer B — Session + Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the frontend a real authenticated session: sign in / sign up / sign out through better-auth, discover the caller's personal workspace via `GET /api/v1/me`, and gate routing so a signed-in user lands in their workspace and an anonymous user is sent to `/login`.

**Architecture:** A narrow `AuthGateway` port normalizes the better-auth client surface; one thin `BetterAuthGateway` adapter wraps the real `createAuthClient`. A Pinia `useSessionStore` depends on the port plus a `MeClient` (same-origin `GET /api/v1/me`), owning session status and identity. Login/Register forms call the store; a router `beforeEach` guard restores the session once and redirects by auth status. This is Layer B of the spec; Layer A (`/api/v1/me`) is already implemented and verified, and Layer C (real editable notes) builds on this store's `personalWorkspaceId`.

**Tech Stack:** Vue 3 (`<script setup>`), Pinia, vue-router, better-auth/client (v1.7, via `@glyphquire/auth`), Zod, Vitest, `@vue/test-utils`, happy-dom.

**Spec:** docs/superpowers/specs/2026-09-03-frontend-auth-workspace-bootstrap-design.md (§4 Layer B)

## Global Constraints

- TypeScript strict; Zod for the `/me` response. Ports-and-adapters: the store depends on the `AuthGateway` interface and `MeClient`, never on `better-auth/client` directly.
- Session lives only in better-auth's httpOnly cookie — NEVER mirror the session token into `localStorage`/Pinia. The store holds only non-secret identity: `userId`, `personalWorkspaceId`, `email`, `status`, `error`.
- All API calls same-origin with `credentials: "same-origin"`; no secret in the bundle.
- The router guard is UX gating, not a security boundary (the API enforces authorization server-side).
- `userId` is an opaque better-auth id (string), `personalWorkspaceId` is a canonical UUID (matches Layer A's `meResultSchema`).
- Naming: components PascalCase, stores `use<Name>Store`, files kebab-case where the repo does. Linter oxlint, formatter oxfmt, tests vitest.
- Web unit tests run with the package's own config: `pnpm --filter @glyphquire/web exec vitest run <file>`.

---

### Task 1: `MeClient` — fetch `GET /api/v1/me`

**Files:**
- Create: `apps/web/src/api/MeClient.ts`
- Create: `apps/web/src/api/MeClient.test.ts`

**Interfaces:**
- Consumes: `meResultSchema`, `type MeResult` from `@glyphquire/api-contract` (Layer A).
- Produces:
  - `interface MeGateway { fetchMe(): Promise<MeResult> }`
  - `class MeClient implements MeGateway` with constructor `(fetchImpl?: FetchLike, baseUrl?: string)` defaulting to `globalThis.fetch` and `""` (same-origin `/api/v1`).
  - `class MeUnauthorizedError extends Error` (thrown on 401/404 — session absent/expired).
  - `class MeRequestError extends Error` (other non-2xx).
  - `type FetchLike = (input: string, init?: RequestInit) => Promise<Response>`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/api/MeClient.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MeClient, MeUnauthorizedError, MeRequestError } from "./MeClient.js";

const validMe = {
  userId: "usr_2N4kQb8fVxErq7wZ",
  personalWorkspaceId: "22222222-2222-4222-8222-222222222222",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MeClient", () => {
  it("GETs /api/v1/me same-origin with credentials and returns the parsed result", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const client = new MeClient(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse(validMe);
    });
    const result = await client.fetchMe();
    expect(result).toEqual(validMe);
    expect(seenUrl).toBe("/api/v1/me");
    expect(seenInit?.method).toBe("GET");
    expect(seenInit?.credentials).toBe("same-origin");
  });

  it("throws MeUnauthorizedError on 404 (no session)", async () => {
    const client = new MeClient(async () => jsonResponse({ code: "NOTE_NOT_FOUND" }, 404));
    await expect(client.fetchMe()).rejects.toBeInstanceOf(MeUnauthorizedError);
  });

  it("throws MeUnauthorizedError on 401", async () => {
    const client = new MeClient(async () => jsonResponse({}, 401));
    await expect(client.fetchMe()).rejects.toBeInstanceOf(MeUnauthorizedError);
  });

  it("throws MeRequestError on 503", async () => {
    const client = new MeClient(async () => jsonResponse({}, 503));
    await expect(client.fetchMe()).rejects.toBeInstanceOf(MeRequestError);
  });

  it("throws MeRequestError when the body fails schema validation", async () => {
    const client = new MeClient(async () => jsonResponse({ userId: "", personalWorkspaceId: "x" }));
    await expect(client.fetchMe()).rejects.toBeInstanceOf(MeRequestError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/api/MeClient.test.ts`
Expected: FAIL — cannot resolve `./MeClient.js`.

- [ ] **Step 3: Write the client**

Create `apps/web/src/api/MeClient.ts`:

```ts
import { meResultSchema, type MeResult } from "@glyphquire/api-contract";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MeGateway {
  fetchMe(): Promise<MeResult>;
}

/** The caller has no valid session (server returns 401/404 before the handler). */
export class MeUnauthorizedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "MeUnauthorizedError";
  }
}

/** Any other failure fetching or validating /api/v1/me. */
export class MeRequestError extends Error {
  constructor(message = "Failed to load account identity") {
    super(message);
    this.name = "MeRequestError";
  }
}

export class MeClient implements MeGateway {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis), baseUrl = "") {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
  }

  async fetchMe(): Promise<MeResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1/me`, {
        method: "GET",
        credentials: "same-origin",
      });
    } catch (cause) {
      throw new MeRequestError(cause instanceof Error ? cause.message : undefined);
    }
    if (response.status === 401 || response.status === 404) throw new MeUnauthorizedError();
    if (!response.ok) throw new MeRequestError();
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MeRequestError();
    }
    const parsed = meResultSchema.safeParse(payload);
    if (!parsed.success) throw new MeRequestError();
    return parsed.data;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/api/MeClient.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @glyphquire/web typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/MeClient.ts apps/web/src/api/MeClient.test.ts
git commit -m "feat: add MeClient for GET /api/v1/me"
```

---

### Task 2: `AuthGateway` Port + `BetterAuthGateway` Adapter

**Files:**
- Create: `apps/web/src/auth/AuthGateway.ts`
- Create: `apps/web/src/auth/BetterAuthGateway.ts`
- Create: `apps/web/src/auth/BetterAuthGateway.test.ts`

**Interfaces:**
- Consumes: `createAuthClient` from `@glyphquire/auth` (existing wrapper of better-auth/client).
- Produces:
  - `interface AuthGateway` (the normalized port the store depends on):
    ```ts
    interface AuthIdentity { userId: string; email: string }
    interface AuthResult { ok: boolean; message?: string }
    interface AuthGateway {
      signIn(email: string, password: string): Promise<AuthResult>;
      signUp(email: string, password: string, name: string): Promise<AuthResult>;
      signOut(): Promise<void>;
      currentIdentity(): Promise<AuthIdentity | null>;
    }
    ```
  - `class BetterAuthGateway implements AuthGateway` with `constructor(authClient: ReturnType<typeof createAuthClient>)` and a `createBetterAuthGateway(baseUrl?: string)` factory defaulting `baseUrl` to `window.location.origin`.

- [ ] **Step 1: Write the failing adapter test (with a fake better-auth client)**

Create `apps/web/src/auth/BetterAuthGateway.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BetterAuthGateway } from "./BetterAuthGateway.js";

// Minimal fake matching the better-auth client shape the adapter touches.
function fakeAuthClient(overrides: Record<string, unknown> = {}) {
  return {
    signIn: { email: async () => ({ data: { user: {} }, error: null }) },
    signUp: { email: async () => ({ data: { user: {} }, error: null }) },
    signOut: async () => ({ data: null, error: null }),
    getSession: async () => ({ data: null, error: null }),
    ...overrides,
  } as never;
}

describe("BetterAuthGateway", () => {
  it("signIn returns ok on success", async () => {
    const gw = new BetterAuthGateway(fakeAuthClient());
    expect(await gw.signIn("a@b.co", "pw")).toEqual({ ok: true });
  });

  it("signIn returns the error message on failure", async () => {
    const gw = new BetterAuthGateway(
      fakeAuthClient({
        signIn: { email: async () => ({ data: null, error: { message: "Invalid credentials" } }) },
      }),
    );
    expect(await gw.signIn("a@b.co", "pw")).toEqual({ ok: false, message: "Invalid credentials" });
  });

  it("currentIdentity maps a live session to { userId, email }", async () => {
    const gw = new BetterAuthGateway(
      fakeAuthClient({
        getSession: async () => ({
          data: { user: { id: "usr_1", email: "a@b.co" }, session: {} },
          error: null,
        }),
      }),
    );
    expect(await gw.currentIdentity()).toEqual({ userId: "usr_1", email: "a@b.co" });
  });

  it("currentIdentity returns null when there is no session", async () => {
    const gw = new BetterAuthGateway(fakeAuthClient());
    expect(await gw.currentIdentity()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/auth/BetterAuthGateway.test.ts`
Expected: FAIL — cannot resolve `./BetterAuthGateway.js`.

- [ ] **Step 3: Write the port**

Create `apps/web/src/auth/AuthGateway.ts`:

```ts
export interface AuthIdentity {
  readonly userId: string;
  readonly email: string;
}

export interface AuthResult {
  readonly ok: boolean;
  readonly message?: string;
}

/**
 * The narrow authentication surface the session store depends on. One adapter
 * ({@link BetterAuthGateway}) wraps the real better-auth client; tests use a
 * fake. The store never imports better-auth/client directly.
 */
export interface AuthGateway {
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(email: string, password: string, name: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  currentIdentity(): Promise<AuthIdentity | null>;
}
```

- [ ] **Step 4: Write the adapter**

Create `apps/web/src/auth/BetterAuthGateway.ts`:

```ts
import { createAuthClient } from "@glyphquire/auth";
import type { AuthGateway, AuthIdentity, AuthResult } from "./AuthGateway.js";

type BetterAuthClient = ReturnType<typeof createAuthClient>;

// better-auth client calls resolve to { data, error }; error carries a message.
interface BetterAuthError {
  message?: string;
}
function errorMessage(error: unknown): string {
  const message = (error as BetterAuthError | null)?.message;
  return typeof message === "string" && message.length > 0 ? message : "Authentication failed";
}

export class BetterAuthGateway implements AuthGateway {
  constructor(private readonly client: BetterAuthClient) {}

  async signIn(email: string, password: string): Promise<AuthResult> {
    const { error } = await this.client.signIn.email({ email, password });
    return error ? { ok: false, message: errorMessage(error) } : { ok: true };
  }

  async signUp(email: string, password: string, name: string): Promise<AuthResult> {
    const { error } = await this.client.signUp.email({ email, password, name });
    return error ? { ok: false, message: errorMessage(error) } : { ok: true };
  }

  async signOut(): Promise<void> {
    await this.client.signOut();
  }

  async currentIdentity(): Promise<AuthIdentity | null> {
    const { data } = await this.client.getSession();
    const user = data?.user;
    if (!user?.id || typeof user.email !== "string") return null;
    return { userId: user.id, email: user.email };
  }
}

/** Builds a gateway against the same-origin better-auth handler (`/api/auth`). */
export function createBetterAuthGateway(
  baseUrl: string = window.location.origin,
): BetterAuthGateway {
  return new BetterAuthGateway(createAuthClient(baseUrl));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/auth/BetterAuthGateway.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck (this locks the adapter against the real better-auth client types)**

Run: `pnpm --filter @glyphquire/web typecheck`
Expected: no errors. If better-auth's real `signIn.email` / `getSession` types differ from the adapter's usage, this step fails here — adjust the adapter body (only) to match the real types; do NOT change the `AuthGateway` port.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/auth/AuthGateway.ts apps/web/src/auth/BetterAuthGateway.ts apps/web/src/auth/BetterAuthGateway.test.ts
git commit -m "feat: add AuthGateway port and better-auth adapter"
```

---

### Task 3: `useSessionStore`

**Files:**
- Create: `apps/web/src/stores/session.ts`
- Create: `apps/web/src/stores/session.test.ts`

**Interfaces:**
- Consumes: `AuthGateway` (Task 2), `MeGateway` / `MeUnauthorizedError` (Task 1).
- Produces: `useSessionStore` (Pinia setup store) with:
  - state refs: `status: "unknown" | "authenticated" | "anonymous"`, `userId: string | null`, `personalWorkspaceId: string | null`, `email: string | null`, `error: string | null`, `pending: boolean`.
  - `configure(gateway: AuthGateway, meClient: MeGateway): void` — test/host seam to inject dependencies (defaults created lazily in production via `createBetterAuthGateway()` + `new MeClient()`).
  - `restore(): Promise<void>` — idempotent; on first call resolves status from `currentIdentity()` + `/me`.
  - `signIn(email, password): Promise<boolean>`, `signUp(email, password, name): Promise<boolean>` — return success; set `error` on failure; on success run bootstrap.
  - `signOut(): Promise<void>` — clears identity → `anonymous`.
  - `bootstrap(): Promise<void>` — fills `userId`/`personalWorkspaceId`/`email` from `currentIdentity()` + `MeClient.fetchMe()`; sets `anonymous` on `MeUnauthorizedError`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/stores/session.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSessionStore } from "./session.js";
import type { AuthGateway, AuthIdentity, AuthResult } from "../auth/AuthGateway.js";
import { MeUnauthorizedError, type MeGateway } from "../api/MeClient.js";

const identity: AuthIdentity = { userId: "usr_1", email: "a@b.co" };
const workspaceId = "22222222-2222-4222-8222-222222222222";

class FakeAuth implements AuthGateway {
  session: AuthIdentity | null = null;
  signInResult: AuthResult = { ok: true };
  throwOnIdentity = false;
  async signIn() {
    if (this.signInResult.ok) this.session = identity;
    return this.signInResult;
  }
  async signUp() {
    this.session = identity;
    return { ok: true } as AuthResult;
  }
  async signOut() {
    this.session = null;
  }
  async currentIdentity() {
    if (this.throwOnIdentity) throw new Error("network down");
    return this.session;
  }
}

class FakeMe implements MeGateway {
  unauthorized = false;
  async fetchMe() {
    if (this.unauthorized) throw new MeUnauthorizedError();
    return { userId: identity.userId, personalWorkspaceId: workspaceId };
  }
}

function setup() {
  const auth = new FakeAuth();
  const me = new FakeMe();
  const store = useSessionStore();
  store.configure(auth, me);
  return { auth, me, store };
}

describe("useSessionStore", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("restore resolves to anonymous when there is no session", async () => {
    const { store } = setup();
    await store.restore();
    expect(store.status).toBe("anonymous");
    expect(store.personalWorkspaceId).toBeNull();
  });

  it("restore resolves to authenticated and loads the workspace when a session exists", async () => {
    const { auth, store } = setup();
    auth.session = identity;
    await store.restore();
    expect(store.status).toBe("authenticated");
    expect(store.userId).toBe("usr_1");
    expect(store.email).toBe("a@b.co");
    expect(store.personalWorkspaceId).toBe(workspaceId);
  });

  it("signIn success authenticates and bootstraps the workspace", async () => {
    const { store } = setup();
    const ok = await store.signIn("a@b.co", "pw");
    expect(ok).toBe(true);
    expect(store.status).toBe("authenticated");
    expect(store.personalWorkspaceId).toBe(workspaceId);
    expect(store.error).toBeNull();
  });

  it("signIn failure records the error and stays anonymous", async () => {
    const { auth, store } = setup();
    auth.signInResult = { ok: false, message: "Invalid credentials" };
    const ok = await store.signIn("a@b.co", "wrong");
    expect(ok).toBe(false);
    expect(store.status).toBe("anonymous");
    expect(store.error).toBe("Invalid credentials");
  });

  it("signOut clears identity to anonymous", async () => {
    const { store } = setup();
    await store.signIn("a@b.co", "pw");
    await store.signOut();
    expect(store.status).toBe("anonymous");
    expect(store.userId).toBeNull();
    expect(store.personalWorkspaceId).toBeNull();
  });

  it("bootstrap sets anonymous when /me is unauthorized", async () => {
    const { auth, me, store } = setup();
    auth.session = identity;
    me.unauthorized = true;
    await store.restore();
    expect(store.status).toBe("anonymous");
  });

  it("does not wedge on a transient currentIdentity() failure and stays retryable", async () => {
    const { auth, store } = setup();
    auth.session = identity;
    auth.throwOnIdentity = true;
    // restore() must resolve (not reject) even though the gateway threw.
    await expect(store.restore()).resolves.toBeUndefined();
    expect(store.status).toBe("unknown");
    expect(store.error).toBe("Could not load your workspace. Please try again.");
    // The failure is retryable: once the network recovers, restore() re-attempts.
    auth.throwOnIdentity = false;
    await store.restore();
    expect(store.status).toBe("authenticated");
    expect(store.personalWorkspaceId).toBe(workspaceId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/stores/session.test.ts`
Expected: FAIL — cannot resolve `./session.js`.

- [ ] **Step 3: Write the store**

Create `apps/web/src/stores/session.ts`:

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import { MeClient, MeUnauthorizedError, type MeGateway } from "../api/MeClient.js";
import { createBetterAuthGateway } from "../auth/BetterAuthGateway.js";
import type { AuthGateway } from "../auth/AuthGateway.js";

type SessionStatus = "unknown" | "authenticated" | "anonymous";

export const useSessionStore = defineStore("session", () => {
  const status = ref<SessionStatus>("unknown");
  const userId = ref<string | null>(null);
  const personalWorkspaceId = ref<string | null>(null);
  const email = ref<string | null>(null);
  const error = ref<string | null>(null);
  const pending = ref(false);

  let gateway: AuthGateway | null = null;
  let meClient: MeGateway | null = null;
  let restorePromise: Promise<void> | null = null;

  function deps(): { gateway: AuthGateway; meClient: MeGateway } {
    if (!gateway) gateway = createBetterAuthGateway();
    if (!meClient) meClient = new MeClient();
    return { gateway, meClient };
  }

  /** Test/host seam: inject fakes before any action runs. */
  function configure(nextGateway: AuthGateway, nextMeClient: MeGateway): void {
    gateway = nextGateway;
    meClient = nextMeClient;
  }

  function clearIdentity(): void {
    userId.value = null;
    personalWorkspaceId.value = null;
    email.value = null;
  }

  // Never rejects. `currentIdentity()` (a network call) is inside the try so a
  // transient failure cannot escape into the router guard and wedge navigation.
  // Definite "no session" → anonymous; a transient error leaves status "unknown"
  // (retryable) so a later navigation re-attempts instead of stranding the user.
  async function bootstrap(): Promise<void> {
    const { gateway: gw, meClient: me } = deps();
    try {
      const identity = await gw.currentIdentity();
      if (!identity) {
        clearIdentity();
        status.value = "anonymous";
        return;
      }
      const meResult = await me.fetchMe();
      userId.value = identity.userId;
      email.value = identity.email;
      personalWorkspaceId.value = meResult.personalWorkspaceId;
      status.value = "authenticated";
    } catch (cause) {
      clearIdentity();
      if (cause instanceof MeUnauthorizedError) {
        status.value = "anonymous"; // definitively no/expired session
      } else {
        status.value = "unknown"; // transient — allow a retry on next navigation
        error.value = "Could not load your workspace. Please try again.";
      }
    }
  }

  /**
   * Idempotent: the first call resolves status; concurrent callers await it.
   * After a transient failure (status still "unknown") the memoized promise is
   * cleared so the next navigation retries. The router guard treats a lingering
   * "unknown" as not-authenticated (fail-closed → /login), so a transient error
   * never grants access and never wedges navigation.
   */
  async function restore(): Promise<void> {
    if (status.value !== "unknown") return;
    if (!restorePromise) restorePromise = bootstrap();
    await restorePromise;
    if (status.value === "unknown") restorePromise = null;
  }

  async function signIn(emailInput: string, password: string): Promise<boolean> {
    const { gateway: gw } = deps();
    pending.value = true;
    error.value = null;
    try {
      const result = await gw.signIn(emailInput, password);
      if (!result.ok) {
        status.value = "anonymous";
        error.value = result.message ?? "Sign in failed";
        return false;
      }
      await bootstrap();
      return status.value === "authenticated";
    } finally {
      pending.value = false;
    }
  }

  async function signUp(emailInput: string, password: string, name: string): Promise<boolean> {
    const { gateway: gw } = deps();
    pending.value = true;
    error.value = null;
    try {
      const result = await gw.signUp(emailInput, password, name);
      if (!result.ok) {
        status.value = "anonymous";
        error.value = result.message ?? "Sign up failed";
        return false;
      }
      await bootstrap();
      return status.value === "authenticated";
    } finally {
      pending.value = false;
    }
  }

  async function signOut(): Promise<void> {
    const { gateway: gw } = deps();
    try {
      await gw.signOut();
    } finally {
      clearIdentity();
      error.value = null;
      status.value = "anonymous";
    }
  }

  return {
    status,
    userId,
    personalWorkspaceId,
    email,
    error,
    pending,
    configure,
    restore,
    bootstrap,
    signIn,
    signUp,
    signOut,
  };
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/stores/session.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @glyphquire/web typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/stores/session.ts apps/web/src/stores/session.test.ts
git commit -m "feat: add session store with auth + workspace bootstrap"
```

---

### Task 4: Wire Login and Register Pages

**Files:**
- Modify: `apps/web/src/pages/LoginPage.vue`
- Modify: `apps/web/src/pages/RegisterPage.vue`
- Create: `apps/web/src/pages/LoginPage.test.ts`
- Create: `apps/web/src/pages/RegisterPage.test.ts`

**Interfaces:**
- Consumes: `useSessionStore` (Task 3), `useRouter` from vue-router.
- Produces: no new exports; the pages become functional forms.

Behavior for both: bind fields with `v-model`; on submit call the store action; while `store.pending`, disable the submit button; show `store.error` inline (`role="alert"`); on success `router.push` to `/workspace/${store.personalWorkspaceId}`.

- [ ] **Step 1: Write the failing LoginPage test**

Create `apps/web/src/pages/LoginPage.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import LoginPage from "./LoginPage.vue";
import { useSessionStore } from "../stores/session.js";

const push = vi.fn();
vi.mock("vue-router", () => ({
  RouterLink: { template: "<a><slot /></a>" },
  useRouter: () => ({ push }),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    push.mockReset();
  });

  it("signs in and routes to the workspace on success", async () => {
    const store = useSessionStore();
    store.signIn = vi.fn(async () => {
      store.personalWorkspaceId = "22222222-2222-4222-8222-222222222222";
      return true;
    });
    const wrapper = mount(LoginPage);
    await wrapper.find("#email").setValue("a@b.co");
    await wrapper.find("#password").setValue("pw");
    await wrapper.find("form").trigger("submit.prevent");
    await Promise.resolve();
    expect(store.signIn).toHaveBeenCalledWith("a@b.co", "pw");
    expect(push).toHaveBeenCalledWith("/workspace/22222222-2222-4222-8222-222222222222");
  });

  it("shows the store error and does not route on failure", async () => {
    const store = useSessionStore();
    store.signIn = vi.fn(async () => {
      store.error = "Invalid credentials";
      return false;
    });
    const wrapper = mount(LoginPage);
    await wrapper.find("#email").setValue("a@b.co");
    await wrapper.find("#password").setValue("wrong");
    await wrapper.find("form").trigger("submit.prevent");
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').text()).toContain("Invalid credentials");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/pages/LoginPage.test.ts`
Expected: FAIL — the current LoginPage has no bound fields / submit handler, so `signIn` is never called.

- [ ] **Step 3: Wire LoginPage**

Replace `apps/web/src/pages/LoginPage.vue` with:

```vue
<template>
  <div class="space-y-6">
    <h2 class="text-xl font-semibold text-center">登入</h2>
    <form class="space-y-4" @submit.prevent="onSubmit">
      <div>
        <label for="email" class="block text-sm font-medium text-gray-700">Email</label>
        <input
          id="email"
          v-model="email"
          type="email"
          autocomplete="email"
          required
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label for="password" class="block text-sm font-medium text-gray-700">密碼</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
        />
      </div>
      <p v-if="session.error" role="alert" class="text-sm text-red-600">{{ session.error }}</p>
      <button
        type="submit"
        :disabled="session.pending"
        class="w-full rounded-md bg-black px-4 py-2 text-white hover:bg-gray-800 disabled:opacity-50"
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
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useSessionStore } from "../stores/session.js";

const session = useSessionStore();
const router = useRouter();
const email = ref("");
const password = ref("");

async function onSubmit(): Promise<void> {
  const ok = await session.signIn(email.value, password.value);
  if (ok && session.personalWorkspaceId) {
    await router.push(`/workspace/${session.personalWorkspaceId}`);
  }
}
</script>
```

- [ ] **Step 4: Run the LoginPage test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/pages/LoginPage.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing RegisterPage test**

Create `apps/web/src/pages/RegisterPage.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RegisterPage from "./RegisterPage.vue";
import { useSessionStore } from "../stores/session.js";

const push = vi.fn();
vi.mock("vue-router", () => ({
  RouterLink: { template: "<a><slot /></a>" },
  useRouter: () => ({ push }),
}));

describe("RegisterPage", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    push.mockReset();
  });

  it("signs up and routes to the workspace on success", async () => {
    const store = useSessionStore();
    store.signUp = vi.fn(async () => {
      store.personalWorkspaceId = "22222222-2222-4222-8222-222222222222";
      return true;
    });
    const wrapper = mount(RegisterPage);
    await wrapper.find("#name").setValue("Ada");
    await wrapper.find("#email").setValue("a@b.co");
    await wrapper.find("#password").setValue("pw");
    await wrapper.find("form").trigger("submit.prevent");
    await Promise.resolve();
    expect(store.signUp).toHaveBeenCalledWith("a@b.co", "pw", "Ada");
    expect(push).toHaveBeenCalledWith("/workspace/22222222-2222-4222-8222-222222222222");
  });

  it("shows the store error on failure", async () => {
    const store = useSessionStore();
    store.signUp = vi.fn(async () => {
      store.error = "Email already registered";
      return false;
    });
    const wrapper = mount(RegisterPage);
    await wrapper.find("#name").setValue("Ada");
    await wrapper.find("#email").setValue("a@b.co");
    await wrapper.find("#password").setValue("pw");
    await wrapper.find("form").trigger("submit.prevent");
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').text()).toContain("Email already registered");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/pages/RegisterPage.test.ts`
Expected: FAIL — RegisterPage has no handler yet.

- [ ] **Step 7: Wire RegisterPage**

Replace `apps/web/src/pages/RegisterPage.vue` with:

```vue
<template>
  <div class="space-y-6">
    <h2 class="text-xl font-semibold text-center">註冊</h2>
    <form class="space-y-4" @submit.prevent="onSubmit">
      <div>
        <label for="name" class="block text-sm font-medium text-gray-700">名稱</label>
        <input
          id="name"
          v-model="name"
          type="text"
          autocomplete="name"
          required
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
          placeholder="你的名字"
        />
      </div>
      <div>
        <label for="email" class="block text-sm font-medium text-gray-700">Email</label>
        <input
          id="email"
          v-model="email"
          type="email"
          autocomplete="email"
          required
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label for="password" class="block text-sm font-medium text-gray-700">密碼</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="new-password"
          required
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
        />
      </div>
      <p v-if="session.error" role="alert" class="text-sm text-red-600">{{ session.error }}</p>
      <button
        type="submit"
        :disabled="session.pending"
        class="w-full rounded-md bg-black px-4 py-2 text-white hover:bg-gray-800 disabled:opacity-50"
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
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useSessionStore } from "../stores/session.js";

const session = useSessionStore();
const router = useRouter();
const name = ref("");
const email = ref("");
const password = ref("");

async function onSubmit(): Promise<void> {
  const ok = await session.signUp(email.value, password.value, name.value);
  if (ok && session.personalWorkspaceId) {
    await router.push(`/workspace/${session.personalWorkspaceId}`);
  }
}
</script>
```

- [ ] **Step 8: Run both page tests to verify they pass**

Run: `pnpm --filter @glyphquire/web exec vitest run src/pages/LoginPage.test.ts src/pages/RegisterPage.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 9: Typecheck + lint**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/pages/LoginPage.vue apps/web/src/pages/RegisterPage.vue`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/pages/LoginPage.vue apps/web/src/pages/RegisterPage.vue apps/web/src/pages/LoginPage.test.ts apps/web/src/pages/RegisterPage.test.ts
git commit -m "feat: wire login and register forms to the session store"
```

---

### Task 5: Router Guard + App-Start Restore

**Files:**
- Modify: `apps/web/src/router/index.ts`
- Create: `apps/web/src/router/guard.ts`
- Create: `apps/web/src/router/guard.test.ts`

**Interfaces:**
- Consumes: `useSessionStore` (Task 3); vue-router `RouteLocationNormalized`.
- Produces:
  - `resolveGuard(store, to): Promise<true | string>` — pure decision function: returns `true` to allow, or a redirect path string. Restores the session (via `store.restore()`) before deciding.
  - `installAuthGuard(router): void` — registers `router.beforeEach` delegating to `resolveGuard`.

Guard rules (from spec §4):
- Public routes: `/login`, `/register`. Protected: everything else (`/`, `/workspace/...`).
- `restore()` first (idempotent) so `status` is `authenticated` or `anonymous` before deciding.
- `anonymous` + protected route → redirect `/login`.
- `authenticated` + `/login` or `/register` → redirect `/workspace/:personalWorkspaceId`.
- `authenticated` + `/` → redirect `/workspace/:personalWorkspaceId` (spec §5.3 default: land in the workspace).
- `unknown` after `restore()` (a transient bootstrap failure that stayed retryable) is treated as NOT authenticated → same as anonymous (protected → `/login`, public allowed). This fails closed and never grants access on a network blip.
- Otherwise allow.

- [ ] **Step 1: Write the failing guard test**

Create `apps/web/src/router/guard.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalized } from "vue-router";
import { useSessionStore } from "../stores/session.js";
import { resolveGuard } from "./guard.js";
import type { AuthGateway, AuthIdentity, AuthResult } from "../auth/AuthGateway.js";
import { type MeGateway } from "../api/MeClient.js";

const identity: AuthIdentity = { userId: "usr_1", email: "a@b.co" };
const workspaceId = "22222222-2222-4222-8222-222222222222";

class FakeAuth implements AuthGateway {
  constructor(public session: AuthIdentity | null) {}
  async signIn() {
    return { ok: true } as AuthResult;
  }
  async signUp() {
    return { ok: true } as AuthResult;
  }
  async signOut() {
    this.session = null;
  }
  async currentIdentity() {
    return this.session;
  }
}
class FakeMe implements MeGateway {
  async fetchMe() {
    return { userId: identity.userId, personalWorkspaceId: workspaceId };
  }
}
function route(path: string): RouteLocationNormalized {
  return { path, fullPath: path, name: undefined } as RouteLocationNormalized;
}
function storeWith(session: AuthIdentity | null) {
  const store = useSessionStore();
  store.configure(new FakeAuth(session), new FakeMe());
  return store;
}

describe("resolveGuard", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("sends an anonymous user from a protected route to /login", async () => {
    const store = storeWith(null);
    expect(await resolveGuard(store, route("/workspace/abc"))).toBe("/login");
  });

  it("allows an anonymous user to reach /login", async () => {
    const store = storeWith(null);
    expect(await resolveGuard(store, route("/login"))).toBe(true);
  });

  it("redirects an authenticated user away from /login to their workspace", async () => {
    const store = storeWith(identity);
    expect(await resolveGuard(store, route("/login"))).toBe(`/workspace/${workspaceId}`);
  });

  it("redirects an authenticated user from / to their workspace", async () => {
    const store = storeWith(identity);
    expect(await resolveGuard(store, route("/"))).toBe(`/workspace/${workspaceId}`);
  });

  it("allows an authenticated user to reach their workspace", async () => {
    const store = storeWith(identity);
    expect(await resolveGuard(store, route(`/workspace/${workspaceId}`))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/router/guard.test.ts`
Expected: FAIL — cannot resolve `./guard.js`.

- [ ] **Step 3: Write the guard**

Create `apps/web/src/router/guard.ts`:

```ts
import type { Router, RouteLocationNormalized } from "vue-router";
import { useSessionStore } from "../stores/session.js";

type SessionStore = ReturnType<typeof useSessionStore>;

const PUBLIC_PATHS = new Set(["/login", "/register"]);

export async function resolveGuard(
  store: SessionStore,
  to: RouteLocationNormalized,
): Promise<true | string> {
  await store.restore();
  const isPublic = PUBLIC_PATHS.has(to.path);

  if (store.status === "authenticated") {
    const workspacePath = store.personalWorkspaceId
      ? `/workspace/${store.personalWorkspaceId}`
      : null;
    if ((isPublic || to.path === "/") && workspacePath) return workspacePath;
    return true;
  }

  // anonymous
  if (isPublic) return true;
  return "/login";
}

export function installAuthGuard(router: Router): void {
  router.beforeEach(async (to) => {
    const store = useSessionStore();
    return resolveGuard(store, to);
  });
}
```

- [ ] **Step 4: Run the guard test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/router/guard.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Install the guard in the router**

In `apps/web/src/router/index.ts`, after the `createRouter({...})` call, add the import at the top and install the guard before exporting:

```ts
import { installAuthGuard } from "./guard.js";
```

and immediately after `export const router = createRouter({ ... });`:

```ts
installAuthGuard(router);
```

- [ ] **Step 6: Typecheck + lint + full web suite**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/router/guard.ts apps/web/src/router/index.ts`
Run: `pnpm --filter @glyphquire/web test`
Expected: all clean; the full web suite stays green (no regressions in existing workbench/editor tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/router/guard.ts apps/web/src/router/guard.test.ts apps/web/src/router/index.ts
git commit -m "feat: gate routes by auth status with workspace redirect"
```

---

## Security Review Dispositions (pre-approval)

Read-only security review verdict: **design sound, no P0–P2**. Dispositions:
- **F1 (P3, availability — `bootstrap()`/`restore()` could wedge navigation on a transient `getSession()` network error):** FIX. `bootstrap()` now wraps `currentIdentity()` in the try and never rejects; a definite no-session → `anonymous`, a transient failure → `unknown` (retryable) with `restorePromise` cleared; the guard treats `unknown` as not-authenticated (fail-closed → `/login`). New store test covers the transient case (no wedge, retryable).
- **F2 (P4, `MeClient` lacks `NoteClient`'s `parseRelativeApiBase` base-URL hardening):** DEFER. Production always constructs `new MeClient()` with `baseUrl = ""`, so exposure is nil; revisit only if a caller ever passes a base.
- **F3 (P4, better-auth's own limiter is disabled, delegating to the shared limiter):** already handled — verified `app.ts:314-321` applies `requireLimiter` + `createAuthRateLimitMiddleware` to `/api/auth/*`, so sign-in is rate-limited. No Layer B action.
- **Sign-up enumeration (P4) and the spec's `/me` `email` mention (informational):** DEFER / no-op. Registration message policy is better-auth's; `email` is correctly read from `currentIdentity()`, not `/me`, so the Layer A `.strict()` `{ userId, personalWorkspaceId }` schema is consistent.

## Security Notes for the Reviewer / Verifier

- No session token is stored anywhere in JS/Pinia/localStorage — the store keeps only `userId`, `personalWorkspaceId`, `email`, and status. Authentication rides better-auth's httpOnly cookie via `credentials: "same-origin"`.
- The router guard is UX only; every API route enforces authorization server-side (Layer A verified). A user forging `status` in devtools gains nothing — the API still rejects unauthenticated calls.
- The `AuthGateway` port is the single seam over better-auth; the adapter's `currentIdentity()` returns `null` unless a real session with `user.id` + `user.email` exists.
- `bootstrap()` treats a `MeUnauthorizedError` (401/404) as "no session" (anonymous), so an expired cookie deterministically lands the user back at `/login` on the next navigation.
- Manual end-to-end check (verifier, with backing services + web dev server): register a new user → lands in `/workspace/:id`; reload → still authenticated; sign out → `/login`; visit `/workspace/:id` while signed out → redirected to `/login`.

## Out of Scope (Layer C and later)

- Replacing the workbench's DEFAULT_NOTES demo data with real notes, the production `WorkbenchSessionFactory`, the Explorer's real list/create/search, and recent-notes — all Layer C.
- A visible sign-out control in the workbench UI is Layer C wiring (the store's `signOut()` exists here; the button that calls it ships with the workbench integration). Session expiry redirect on a live 401 from note calls is also Layer C, where the note clients run.
