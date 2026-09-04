# Frontend Auth Layer C-0 — Opaque User Id in Session Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a latent, pre-existing schema mismatch across the client-side editing-session critical path (`NoteLock`, `TabChannel`, `SessionLifecycleCoordinator`, `DraftStore`, `AuthenticatedWorkbenchHost`, `WorkbenchPage`) so a real better-auth user id — which is opaque text, not a canonical UUID — can flow through cross-tab lock naming, session-lifecycle validation, local draft persistence, and conflict recovery without throwing or silently dropping data. This is a prerequisite for the main Layer C plan (production `WorkbenchSessionFactory`), which cannot pass a real authenticated `actorId` through this path until it lands.

**Architecture:** Six sites validate `userId` with `canonicalUuidSchema` even though none of them depend on UUID structure — each only ever (a) compares it for equality, (b) interpolates it into a delimited name/key (`:`- or `::`-separated), or (c) gates a UI action. This plan introduces one shared, colon-safe opaque-id schema (Task 1) and swaps `userId` to it at each site: `noteScopeSchema` (Task 2, `TabChannel.ts`), `liveBrowserSessionSchema` (Task 3, `SessionLifecycleCoordinator.ts`), the `endUserLocally` local-cleanup success/failure invariant (Task 4, same file — a pre-existing concurrency correctness bug, independent of id format, found during Task 3's review and fixed here since it sits on the same code path), `draftKeySchema` + `clearForUser` (Task 5, `DraftStore.ts`), `assertCanonicalIdentity`'s `userId` check (Task 6, `AuthenticatedWorkbenchHost.ts`), and `onConflictRecovery`'s `userId` check (Task 7, `WorkbenchPage.vue`). `workspaceId`/`noteId` stay `canonicalUuidSchema` everywhere (those really are UUID database columns).

**Tech Stack:** TypeScript strict, Zod, Vitest.

**Spec:** docs/superpowers/specs/2026-09-03-frontend-auth-workspace-bootstrap-design.md (§5.1 — this plan is a discovered prerequisite for the production session factory that section describes; not itself in the original spec text)

## Global Constraints

- Do not change `canonicalUuidSchema` usage for `workspaceId`/`noteId` anywhere — only `userId` in the two named schemas.
- The new user-id schema must reject the `:` character specifically, in addition to `opaqueAuthIdSchema`'s existing bounds (non-empty, ≤200 UTF-8 bytes) — `noteLockName`/`tabChannelName` build `${prefix}:${userId}:${workspaceId}:${noteId}`, and an unconstrained userId could otherwise contain `:` and make the delimited name ambiguous.
- A canonical UUID must still validate under the new schema (it is a subset) — this preserves every existing positive test fixture unchanged.
- No behavior change to workspace/note id validation, lock semantics, or session-lifecycle authorization logic beyond what each task explicitly describes — this is a schema-widening fix (plus one narrowly-scoped concurrency-invariant fix in Task 4) only.
- Linter oxlint, formatter oxfmt, tests vitest. Web tests: `pnpm --filter @glyphquire/web exec vitest run <file>`.
- Task 4's fix must not change any externally observable behavior on the success path (existing tests for successful logout/switchAccount stay green unchanged) — it only strengthens the invariant `endedUsers.has(userId) ⇒ local cleanup for that userId succeeded`, which currently does not hold.

---

### Task 1: Shared Colon-Safe User Id Schema

**Files:**
- Create: `apps/web/src/coordination/userIdSchema.ts`
- Create: `apps/web/src/coordination/userIdSchema.test.ts`

**Interfaces:**
- Produces: `export const coordinationUserIdSchema: ZodType<string>` — non-empty, ≤200 UTF-8 bytes (matching `MAX_AUTH_ID_BYTES` from `@glyphquire/api-contract`), and must NOT contain `:`. A canonical UUID satisfies this (it has no `:`).
- Consumed by Task 2 (`TabChannel.ts`) and Task 3 (`SessionLifecycleCoordinator.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/coordination/userIdSchema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { coordinationUserIdSchema } from "./userIdSchema.js";

describe("coordinationUserIdSchema", () => {
  it("accepts a canonical UUID (existing callers are unaffected)", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(coordinationUserIdSchema.parse(uuid)).toBe(uuid);
  });

  it("accepts an opaque better-auth-shaped id", () => {
    const opaque = "usr_2N4kQb8fVxErq7wZ";
    expect(coordinationUserIdSchema.parse(opaque)).toBe(opaque);
  });

  it("rejects an empty string", () => {
    expect(() => coordinationUserIdSchema.parse("")).toThrow();
  });

  it("rejects a value containing a colon (would corrupt the delimited lock/channel name)", () => {
    expect(() => coordinationUserIdSchema.parse("evil:user")).toThrow();
  });

  it("rejects a value over 200 UTF-8 bytes", () => {
    expect(() => coordinationUserIdSchema.parse("a".repeat(201))).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination/userIdSchema.test.ts`
Expected: FAIL — cannot resolve `./userIdSchema.js`.

- [ ] **Step 3: Write the schema**

Create `apps/web/src/coordination/userIdSchema.ts`:

```ts
import { z } from "zod";

const MAX_USER_ID_BYTES = 200;
const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * User id accepted by cross-tab coordination scope (NoteScope, LiveBrowserSession).
 * A better-auth user id is opaque text, NOT a canonical UUID — unlike workspaceId
 * and noteId, which are real UUID database columns. This schema accepts any
 * non-empty, byte-bounded string EXCEPT one containing `:`, because userId is
 * interpolated into `:`-delimited BroadcastChannel/LockManager names
 * (`noteLockName`, `tabChannelName`); an unconstrained value could otherwise
 * make that delimited name ambiguous. A canonical UUID satisfies this schema
 * (it contains no `:`), so existing UUID-based fixtures remain valid unchanged.
 */
export const coordinationUserIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes(":"), {
    message: "User id must not contain \":\"",
  })
  .superRefine((value, context) => {
    if (utf8ByteLength(value) > MAX_USER_ID_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `User id must be at most ${MAX_USER_ID_BYTES} UTF-8 bytes`,
      });
    }
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination/userIdSchema.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @glyphquire/web typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/coordination/userIdSchema.ts apps/web/src/coordination/userIdSchema.test.ts
git commit -m "feat: add colon-safe opaque user id schema for session coordination"
```

---

### Task 2: Relax `NoteScope.userId` (TabChannel + NoteLock)

**Files:**
- Modify: `apps/web/src/coordination/TabChannel.ts:1-13`
- Test: `apps/web/src/coordination/TabChannel.test.ts` (add one new test; existing tests unchanged)

**Interfaces:**
- Consumes: `coordinationUserIdSchema` from `./userIdSchema.js` (Task 1).
- Produces: `noteScopeSchema` with `userId: coordinationUserIdSchema` (was `canonicalUuidSchema`). `NoteScope` type shape is unchanged (`userId: string` either way). `NoteLock` (`NoteLock.ts`) consumes `NoteScope` and needs NO code change — it only builds `noteLockName` from the parsed scope, which still works for any valid opaque userId.

- [ ] **Step 1: Write the failing test proving an opaque userId now works**

Add to `apps/web/src/coordination/TabChannel.test.ts` (append near the existing scope-validation tests; read the file first to match its existing `describe`/import structure and add inside the appropriate `describe` block):

```ts
it("accepts an opaque, non-UUID userId (real better-auth ids are not UUIDs)", () => {
  const opaqueScope = { ...SCOPE, userId: "usr_2N4kQb8fVxErq7wZ" };
  expect(() => noteScopeSchema.parse(opaqueScope)).not.toThrow();
});

it("still rejects a userId containing a colon", () => {
  const badScope = { ...SCOPE, userId: "evil:user" };
  expect(() => noteScopeSchema.parse(badScope)).toThrow();
});
```

(`SCOPE` is already defined in this file — reuse it. `noteScopeSchema` is NOT currently imported in `TabChannel.test.ts` (only the `NoteScope` type and `SCOPE` are in scope) — add `noteScopeSchema` to the existing import from `./TabChannel.js` at the top of the test file so these two new assertions can call it directly.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination/TabChannel.test.ts`
Expected: FAIL on the first new test — `canonicalUuidSchema` rejects `"usr_2N4kQb8fVxErq7wZ"`.

- [ ] **Step 3: Relax the schema**

In `apps/web/src/coordination/TabChannel.ts`, change the import and the `userId` field:

```ts
import { canonicalUuidSchema } from "@glyphquire/api-contract";
import { z } from "zod";
import { coordinationUserIdSchema } from "./userIdSchema.js";

/** The complete tenant/note identity for one advisory cross-tab channel. */
export const noteScopeSchema = z
  .object({
    userId: coordinationUserIdSchema,
    workspaceId: canonicalUuidSchema,
    noteId: canonicalUuidSchema,
  })
  .strict();
```

(`canonicalUuidSchema` stays imported and used for `workspaceId`/`noteId` — only the `userId` line changes.)

- [ ] **Step 4: Run the full TabChannel + NoteLock suites to verify everything still passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination/TabChannel.test.ts src/coordination/NoteLock.test.ts`
Expected: PASS, all tests (existing UUID-based fixtures are unaffected since a UUID satisfies `coordinationUserIdSchema`; the two new tests pass).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @glyphquire/web typecheck`
Expected: no errors.

- [ ] **Step 6: Lint**

Run: `pnpm exec oxlint apps/web/src/coordination/TabChannel.ts apps/web/src/coordination/TabChannel.test.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/coordination/TabChannel.ts apps/web/src/coordination/TabChannel.test.ts
git commit -m "feat: accept opaque non-UUID userId in NoteScope"
```

---

### Task 3: Relax `LiveBrowserSession.userId` (SessionLifecycleCoordinator) + Fix the Now-Invalid Negative Test

**Files:**
- Modify: `apps/web/src/coordination/SessionLifecycleCoordinator.ts:1-28`
- Modify: `apps/web/src/coordination/SessionLifecycleCoordinator.test.ts` (fix one existing assertion, add one new test)

**Interfaces:**
- Consumes: `coordinationUserIdSchema` from `./userIdSchema.js` (Task 1).
- Produces: `liveBrowserSessionSchema` with `userId: coordinationUserIdSchema` (was `canonicalUuidSchema`). `LiveBrowserSession` type shape unchanged.

- [ ] **Step 1: Fix the now-incorrect negative test FIRST (it currently asserts the old, now-wrong behavior)**

In `apps/web/src/coordination/SessionLifecycleCoordinator.test.ts`, find the test `"rejects tampered session and workspace identities at the schema boundary"` (currently around line 110). Its first assertion constructs a coordinator with `userId: "not-a-uuid"` and expects `.toThrow()` — under the relaxed schema, `"not-a-uuid"` is now a VALID opaque userId (no colon, non-empty, under the byte limit), so this assertion would incorrectly fail once Step 2 lands. Replace that first block's `userId` value with a genuinely-invalid one under the new schema — a value containing a colon:

```ts
it("rejects tampered session and workspace identities at the schema boundary", () => {
  expect(
    () =>
      new BrowserSessionLifecycleCoordinator({
        initialSession: {
          userId: "evil:user",
          expiresAt: 10_000,
          workspaceIds: [WORKSPACE_A],
        },
        draftStore: { clearForUser: async () => undefined },
        clock: { now: () => 1_000 },
        channelFactory: isolatedChannelFactory(),
      }),
  ).toThrow();

  expect(
    () =>
      new BrowserSessionLifecycleCoordinator({
        initialSession: {
          userId: USER_A,
          expiresAt: 10_000,
          workspaceIds: [WORKSPACE_A, "forged-workspace"],
        },
        draftStore: { clearForUser: async () => undefined },
        clock: { now: () => 1_000 },
        channelFactory: isolatedChannelFactory(),
      }),
  ).toThrow();
});
```

(Only the `userId` value in the first sub-assertion changes from `"not-a-uuid"` to `"evil:user"`; the second sub-assertion, which tests a tampered `workspaceIds` entry, is untouched — `workspaceId` still requires a canonical UUID.)

- [ ] **Step 2: Run to verify this specific test currently passes against the OLD (pre-Step-3) schema**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination/SessionLifecycleCoordinator.test.ts -t "rejects tampered session"`
Expected: PASS — `"evil:user"` is also rejected by the current `canonicalUuidSchema`, so this is a safe intermediate state before the schema change.

- [ ] **Step 3: Write the failing test proving an opaque userId now works for a live session**

Add a new test near the top-level session-construction tests in the same file (match the file's existing helper usage — `liveSession(...)`/direct construction, whichever the file already uses for valid-session setup; read the file to match its pattern):

```ts
it("accepts an opaque, non-UUID userId as a live session identity", () => {
  expect(
    () =>
      new BrowserSessionLifecycleCoordinator({
        initialSession: {
          userId: "usr_2N4kQb8fVxErq7wZ",
          expiresAt: 10_000,
          workspaceIds: [WORKSPACE_A],
        },
        draftStore: { clearForUser: async () => undefined },
        clock: { now: () => 1_000 },
        channelFactory: isolatedChannelFactory(),
      }),
  ).not.toThrow();
});
```

- [ ] **Step 4: Run to verify the new test fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination/SessionLifecycleCoordinator.test.ts -t "accepts an opaque"`
Expected: FAIL — `canonicalUuidSchema` still rejects the opaque id (schema not yet relaxed).

- [ ] **Step 5: Relax the schema**

In `apps/web/src/coordination/SessionLifecycleCoordinator.ts`, add the import and change the `userId` field:

```ts
import { canonicalUuidSchema } from "@glyphquire/api-contract";
import { z } from "zod";
import { coordinationUserIdSchema } from "./userIdSchema.js";
```

```ts
export const liveBrowserSessionSchema = z
  .object({
    userId: coordinationUserIdSchema,
    expiresAt: z.number().int().safe().positive(),
    workspaceIds: z
      .array(canonicalUuidSchema)
      .min(1)
      .max(1_000)
      .superRefine((workspaceIds, context) => {
        if (new Set(workspaceIds).size !== workspaceIds.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Workspace authorizations must be unique",
          });
        }
      }),
  })
  .strict();
```

(Only the `userId` line changes; `workspaceIds` stays `canonicalUuidSchema`-based.)

- [ ] **Step 6: Run the full SessionLifecycleCoordinator suite to verify everything passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination/SessionLifecycleCoordinator.test.ts`
Expected: PASS, all tests (the fixed negative test from Step 1 still throws on `"evil:user"`; the new positive test from Step 3 now passes; every other existing test — which use canonical-UUID `USER_A`/`USER_B` fixtures — is unaffected).

- [ ] **Step 7: Run the broader coordination + editor session suites to catch any transitive assumption**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination src/editors/EditorSession.test.ts src/editors/mode-sync.test.ts`
Expected: PASS, no regressions (`EditorSession.ts` constructs `noteScopeSchema` from `deps.userId`; its existing tests use canonical-UUID fixtures, which remain valid).

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @glyphquire/web typecheck`
Expected: no errors.

- [ ] **Step 9: Lint**

Run: `pnpm exec oxlint apps/web/src/coordination/SessionLifecycleCoordinator.ts apps/web/src/coordination/SessionLifecycleCoordinator.test.ts`
Expected: clean.

- [ ] **Step 10: Full web suite (final regression guard for this plan)**

Run: `pnpm --filter @glyphquire/web test`
Expected: PASS, full suite green, no regressions anywhere in the app.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/coordination/SessionLifecycleCoordinator.ts apps/web/src/coordination/SessionLifecycleCoordinator.test.ts
git commit -m "feat: accept opaque non-UUID userId in live browser session"
```

---

### Task 4: Fix the `endedUsers` Success/Failure Invariant in `endUserLocally`

**Files:**
- Modify: `apps/web/src/coordination/SessionLifecycleCoordinator.ts` (the `endUserLocally` private method)
- Test: `apps/web/src/coordination/SessionLifecycleCoordinator.test.ts` (add one new test)

**Why (found during Task 3's pre-approval security review, same file, same code path):** `endUserLocally` currently does `this.endedUsers.add(userId)` (marking that user's local cleanup as done) BEFORE awaiting `this.draftStore.clearForUser(userId)` — so if `clearForUser` rejects (for ANY reason — quota exceeded, IndexedDB unavailable, private-browsing mode; independent of id format), the user is already marked "ended" even though their drafts were never cleared. Callers discard the failure silently (`installSession`'s reaction does `void this.enqueueTransition(() => this.endUserLocally(session.userId)).catch(() => undefined)`), so a `clearForUser` failure is invisible. Once `endedUsers` marks the user, the top-of-function guard (`if (this.endedUsers.has(userId)) return;`) makes any later re-attempt a silent no-op. A retry path IS reachable: two `logout()` calls issued back-to-back before the UI disables the control both capture the same `currentSession.userId`, and because `Promise.allSettled` leaves the failed editor/channel entries still registered in `this.editors`/`this.controlChannels`, the second (serialized via `transitionTail`) call reaches `endUserLocally(userId)` again with `hasMatchingState` still true. Under the current code that second call short-circuits at the guard and reports success without clearing anything; under the fix it genuinely retries the cleanup. On a shared browser profile this is the difference between a departed user's local draft content being swept on retry vs. silently left on disk. This is a real, pre-existing concurrency-correctness bug independent of the opaque-userId question, sitting on the exact code path this plan's Tasks 2–3 unblock for real users, so it is fixed here rather than tracked separately.

**Interfaces:**
- Consumes/modifies only `SessionLifecycleCoordinator.ts`'s existing private state (`endedUsers`) and the existing public `logout(networkLogout)` / `switchAccount(nextSession, networkLogout?)` methods (unchanged signatures).
- No new public API. `endUserLocally`'s external contract (still throws an `AggregateError` on any local-cleanup failure) is unchanged — only the timing of `endedUsers.add(userId)` moves.

- [ ] **Step 1: Write the failing regression test**

Add to `apps/web/src/coordination/SessionLifecycleCoordinator.test.ts`, near the existing `"clears and locks locally and broadcasts inbound logout even when network logout rejects"` test (same file, same helper imports already in scope — `USER_A`, `liveSession`, `isolatedChannelFactory`, `scope`):

```ts
it("surfaces a local draft-clearing failure instead of silently marking the user as cleaned up", async () => {
  const clearForUserError = new Error("IndexedDB unavailable");
  const clearForUser = vi.fn(async () => {
    throw clearForUserError;
  });
  const coordinator = new BrowserSessionLifecycleCoordinator({
    initialSession: liveSession(),
    draftStore: { clearForUser },
    clock: { now: () => 1_000 },
    channelFactory: isolatedChannelFactory(),
  });
  const lockPriorAccount = vi.fn(async () => undefined);
  coordinator.registerEditor(scope(), lockPriorAccount);

  await expect(coordinator.logout(async () => undefined)).rejects.toThrow(AggregateError);

  expect(clearForUser).toHaveBeenCalledWith(USER_A);
  // The prior account's lock is still cleared even though the draft clear failed
  // (independent failure modes are both attempted and both reported).
  expect(lockPriorAccount).toHaveBeenCalledOnce();
  coordinator.dispose();
});
```

- [ ] **Step 2: Run the test to verify it currently passes for the wrong reason (documents the pre-fix baseline)**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination/SessionLifecycleCoordinator.test.ts -t "surfaces a local draft-clearing failure"`
Expected: PASS already — the `AggregateError` is thrown correctly today (the bug is NOT that the error fails to throw; it is that `endedUsers` gets marked despite the throw, an internal invariant this specific test cannot observe from the outside, since `endedUsers` is private and there is no public retry path to demonstrate the consequence through today's API). This step confirms the throw-on-failure behavior is intact before Step 4's reorder, so Step 4 cannot be verified as "fixing a failing test" in the usual TDD sense — instead Step 3 documents the invariant directly.

- [ ] **Step 3: Make the code change (Step 1's test guards throw-on-failure; the retry-path strengthening is a deferred P4 follow-up — see below)**

The reordering makes the invariant `endedUsers.has(userId) ⇒ that user's local cleanup succeeded` hold by construction. Step 1's test guards that a `clearForUser` failure is never swallowed (still throws `AggregateError`). A stronger test that directly exercises the overlapping-`logout()` retry path described in the "Why" above (make `clearForUser` fail once then succeed across two back-to-back `logout()` calls, assert it is called a second time and eventually succeeds) is a worthwhile follow-up but is **deferred (P4)** here: a deterministic two-overlapping-`logout()` test depends on `transitionTail` scheduling and is prone to flakiness, and the pre-approval security review explicitly rated it optional/non-blocking. The invariant-by-construction change plus the throw-on-failure guard are sufficient for this task to land safely.

In `apps/web/src/coordination/SessionLifecycleCoordinator.ts`, in `endUserLocally`, move `this.endedUsers.add(userId)` from immediately after the `hasMatchingState` check to immediately before the function's final (success-path) return — i.e., only mark a user as locally cleaned up once `failures.length === 0` is known. The `currentSession`/expiry-timer clearing stays exactly where it is (eager, before the awaits) — that governs *session* state, not the per-user local-cleanup retry invariant, and eager session clearing is required for the new account to be authorized promptly regardless of whether old drafts finish clearing.

Change this:

```ts
  private async endUserLocally(userId: string): Promise<void> {
    if (this.endedUsers.has(userId)) return;
    const hasMatchingState =
      this.currentSession?.userId === userId ||
      [...this.editors.values()].some((editor) => editor.scope.userId === userId);
    if (!hasMatchingState) return;

    this.endedUsers.add(userId);
    if (this.currentSession?.userId === userId) {
      this.currentSession = undefined;
      this.clearExpiryTimer();
    }

    const matchingEditors = [...this.editors.values()].filter(
      (editor) => editor.scope.userId === userId,
    );
    const lockResults = await Promise.allSettled(
      matchingEditors.map((editor) => editor.lockAndClear()),
    );

    const matchingChannels = this.controlChannels.filter((entry) => entry.scope.userId === userId);
    const localResults = await Promise.allSettled([
      this.draftStore.clearForUser(userId),
      ...matchingChannels.map(async (entry) => entry.channel.postLogout()),
    ]);

    // Let BroadcastChannel enqueue delivery before old-account channels close.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.closeControlChannelsForUser(userId);

    const failures = [...lockResults, ...localResults]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Local session clearing failed");
    }
  }
```

To this:

```ts
  private async endUserLocally(userId: string): Promise<void> {
    if (this.endedUsers.has(userId)) return;
    const hasMatchingState =
      this.currentSession?.userId === userId ||
      [...this.editors.values()].some((editor) => editor.scope.userId === userId);
    if (!hasMatchingState) return;

    // `endedUsers` is marked only once local cleanup fully succeeds (see below) —
    // NOT here — so a failed clearForUser (quota exceeded, IndexedDB unavailable,
    // private browsing) never permanently forecloses this instance from retrying
    // this user's local cleanup. Session state below is cleared eagerly regardless,
    // since the new account must be authorized promptly whether or not the old
    // account's local drafts finish clearing.
    if (this.currentSession?.userId === userId) {
      this.currentSession = undefined;
      this.clearExpiryTimer();
    }

    const matchingEditors = [...this.editors.values()].filter(
      (editor) => editor.scope.userId === userId,
    );
    const lockResults = await Promise.allSettled(
      matchingEditors.map((editor) => editor.lockAndClear()),
    );

    const matchingChannels = this.controlChannels.filter((entry) => entry.scope.userId === userId);
    const localResults = await Promise.allSettled([
      this.draftStore.clearForUser(userId),
      ...matchingChannels.map(async (entry) => entry.channel.postLogout()),
    ]);

    // Let BroadcastChannel enqueue delivery before old-account channels close.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.closeControlChannelsForUser(userId);

    const failures = [...lockResults, ...localResults]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Local session clearing failed");
    }
    this.endedUsers.add(userId);
  }
```

- [ ] **Step 4: Run the full SessionLifecycleCoordinator suite to verify no regression**

Run: `pnpm --filter @glyphquire/web exec vitest run src/coordination/SessionLifecycleCoordinator.test.ts`
Expected: PASS, all tests including the new one from Step 1 — every existing success-path test (logout, switchAccount, workspace-revocation) is unaffected because `endedUsers.add(userId)` still executes on every success path, just moved to the end of the function instead of the start.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @glyphquire/web typecheck`
Expected: no errors.

- [ ] **Step 6: Lint**

Run: `pnpm exec oxlint apps/web/src/coordination/SessionLifecycleCoordinator.ts apps/web/src/coordination/SessionLifecycleCoordinator.test.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/coordination/SessionLifecycleCoordinator.ts apps/web/src/coordination/SessionLifecycleCoordinator.test.ts
git commit -m "fix: only mark local session cleanup done after it actually succeeds"
```

---

### Task 5: Relax `DraftStore`'s `userId` Validation

**Files:**
- Modify: `apps/web/src/persistence/DraftStore.ts` (`draftKeySchema` and `clearForUser`)
- Test: `apps/web/src/persistence/DraftStore.test.ts` (add tests; check for and fix any existing UUID-only-userId negative assertion first)

**Interfaces:**
- Consumes: `coordinationUserIdSchema` from `../coordination/userIdSchema.js` (Task 1).
- Produces: `draftKeySchema` with `userId: coordinationUserIdSchema` (was `canonicalUuidSchema`); `clearForUser(userId: string)` validates with `coordinationUserIdSchema` instead of `canonicalUuidSchema` directly. `draftRecordId` (which joins `[userId, workspaceId, noteId]` with `SEPARATOR = "::"`) needs no code change — `coordinationUserIdSchema`'s colon-rejection already makes `userId` safe against the `"::"` separator (any string containing `":"` is rejected, and `"::"` contains `":"`).

- [ ] **Step 1: Check for an existing UUID-only-userId negative test and note its location**

Run: `grep -n "not-a-uuid\|canonicalUuid" apps/web/src/persistence/DraftStore.test.ts`
If this returns a negative assertion using a non-UUID `userId` expected to throw, note its exact location — you will need to replace that `userId` value with a value containing `:` (e.g. `"evil:user"`) in Step 5, mirroring Task 3 Step 1's fix, so the test's "invalid identity is rejected" intent survives the relaxation. If no such assertion exists, no test needs fixing — proceed to Step 2.

- [ ] **Step 2: Write the failing test proving an opaque userId now works**

Add to `apps/web/src/persistence/DraftStore.test.ts`, reusing the file's existing helpers — `makeRecord(overrides)` (builds a valid `DraftRecord`; requires `updatedAt`), `fakeClock`, and the constants `WORKSPACE` / `NOTE_1` (do NOT introduce new `WORKSPACE_ID`/`NOTE_ID` names — they don't exist in this file). Note `operationId` is validated as a canonical UUID, so use `makeRecord` (which supplies a valid `OP_1`) rather than a hand-built literal; only `userId` is the opaque value under test:

```ts
it("accepts an opaque, non-UUID userId for put/get/clearForUser (real better-auth ids are not UUIDs)", async () => {
  const opaqueUserId = "usr_2N4kQb8fVxErq7wZ";
  const clock = fakeClock(1_000);
  const store = new IndexedDbDraftStore({ clock });
  const record = makeRecord({ userId: opaqueUserId, updatedAt: clock.now() });

  await store.put(record);
  const loaded = await store.get({ userId: opaqueUserId, workspaceId: WORKSPACE, noteId: NOTE_1 });

  expect(loaded).toEqual(record);
  await expect(store.clearForUser(opaqueUserId)).resolves.toBeUndefined();
});
```

(This mirrors the existing `"round-trips a draft keyed by user/workspace/note"` test exactly, changing only `userId` to the opaque value — reuse `makeRecord`/`fakeClock`/`WORKSPACE`/`NOTE_1` already defined at the top of the file; do not redefine them.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/persistence/DraftStore.test.ts -t "accepts an opaque"`
Expected: FAIL — `canonicalUuidSchema` rejects the opaque userId in `draftKeySchema`/`clearForUser`.

- [ ] **Step 4: Relax the schema**

In `apps/web/src/persistence/DraftStore.ts`:

1. Add the import: `import { coordinationUserIdSchema } from "../coordination/userIdSchema.js";`
2. In `draftKeySchema`, change `userId: canonicalUuidSchema,` to `userId: coordinationUserIdSchema,` (leave `workspaceId: canonicalUuidSchema` and `noteId: canonicalUuidSchema` unchanged).
3. In `clearForUser`, change `const validatedUserId = canonicalUuidSchema.parse(userId);` to `const validatedUserId = coordinationUserIdSchema.parse(userId);`.

- [ ] **Step 5: If Step 1 found an existing negative test, fix it now**

If Step 1 found a `userId`-format negative assertion using a non-colon, non-UUID string (e.g. `"not-a-uuid"`), replace that value with one containing a colon (e.g. `"evil:user"`) so it is still genuinely rejected under the relaxed schema, mirroring Task 3 Step 1's fix exactly. If Step 1 found nothing, skip this step.

- [ ] **Step 6: Run the full DraftStore suite to verify everything passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/persistence/DraftStore.test.ts`
Expected: PASS, all tests (existing canonical-UUID fixtures remain valid; the new opaque-id test passes; any fixed negative test still throws).

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/persistence/DraftStore.ts apps/web/src/persistence/DraftStore.test.ts`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/persistence/DraftStore.ts apps/web/src/persistence/DraftStore.test.ts
git commit -m "feat: accept opaque non-UUID userId in DraftStore"
```

---

### Task 6: Relax `AuthenticatedWorkbenchHost`'s `userId` Check

**Files:**
- Modify: `apps/web/src/providers/AuthenticatedWorkbenchHost.ts`
- Test: `apps/web/src/providers/AuthenticatedWorkbenchHost.test.ts` (fix one existing test, add one new test)

**Interfaces:**
- Consumes: `coordinationUserIdSchema` from `../coordination/userIdSchema.js` (Task 1).
- Produces: a new `assertOpaqueUserIdentity(value, label)` function alongside the existing `assertCanonicalIdentity` — `provideAuthenticatedWorkbenchHost` calls `assertOpaqueUserIdentity(options.userId, "userId")` and keeps `assertCanonicalIdentity(options.workspaceId, "workspaceId")` unchanged (workspaceId really is a UUID database column).

- [ ] **Step 1: Fix the now-incorrect negative test FIRST**

In `apps/web/src/providers/AuthenticatedWorkbenchHost.test.ts`, find `"rejects missing or non-canonical identity before providing a host"` (currently constructs `{ userId: "not-a-uuid", workspaceId: WORKSPACE_ID, sessionFactory }` and expects a throw containing `"canonical authenticated identity"`). Under the relaxed schema, `"not-a-uuid"` becomes a VALID `userId`, so this specific case would no longer throw. Split it into two tests — one still covering an invalid `workspaceId` (unchanged, still canonical-UUID-gated), one covering a genuinely-invalid `userId` under the new schema:

```ts
it("rejects a non-canonical workspaceId before providing a host", () => {
  const invalid: AuthenticatedWorkbenchHostOptions = {
    userId: USER_ID,
    workspaceId: "not-a-uuid",
    sessionFactory,
  };

  expect(() => provideAuthenticatedWorkbenchHost(invalid)).toThrow(
    "canonical authenticated identity: workspaceId",
  );
});

it("rejects an invalid userId (empty or containing a colon) before providing a host", () => {
  const invalid: AuthenticatedWorkbenchHostOptions = {
    userId: "evil:user",
    workspaceId: WORKSPACE_ID,
    sessionFactory,
  };

  expect(() => provideAuthenticatedWorkbenchHost(invalid)).toThrow("identity: userId");
});
```

(Remove the old single test they replace. Adjust the exact throw-message substring assertions to match what Step 3's implementation actually throws — see Step 3's error message text below, which these tests must match.)

- [ ] **Step 2: Run to verify the new userId test fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/providers/AuthenticatedWorkbenchHost.test.ts -t "rejects an invalid userId"`
Expected: FAIL — `assertCanonicalIdentity` still rejects `"evil:user"` today, but for the wrong reason relative to what Step 3 will make it (this documents intent; proceed).

- [ ] **Step 3: Add the opaque-identity assertion and use it for userId**

In `apps/web/src/providers/AuthenticatedWorkbenchHost.ts`, add the import and a second assertion function, then use it for `userId` only:

```ts
import { coordinationUserIdSchema } from "../coordination/userIdSchema.js";
```

```ts
function assertCanonicalIdentity(value: string | undefined, label: string): string {
  if (!value || !canonicalUuidSchema.safeParse(value).success) {
    throw new Error(`Missing or non-canonical authenticated identity: ${label}`);
  }
  return value;
}

/** `userId` is a better-auth user id — opaque text, not a UUID — unlike `workspaceId`. */
function assertOpaqueUserIdentity(value: string | undefined, label: string): string {
  if (!value || !coordinationUserIdSchema.safeParse(value).success) {
    throw new Error(`Missing or invalid authenticated identity: ${label}`);
  }
  return value;
}
```

Then change the two call sites:

```ts
  const userId = assertOpaqueUserIdentity(options.userId, "userId");
  const workspaceId = assertCanonicalIdentity(options.workspaceId, "workspaceId");
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/providers/AuthenticatedWorkbenchHost.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/providers/AuthenticatedWorkbenchHost.ts apps/web/src/providers/AuthenticatedWorkbenchHost.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/providers/AuthenticatedWorkbenchHost.ts apps/web/src/providers/AuthenticatedWorkbenchHost.test.ts
git commit -m "feat: accept opaque non-UUID userId in AuthenticatedWorkbenchHost"
```

---

### Task 7: Relax `WorkbenchPage`'s Conflict-Recovery `userId` Check

**Files:**
- Modify: `apps/web/src/pages/WorkbenchPage.vue`
- Test: `apps/web/src/pages/WorkbenchPage.test.ts` (fix one existing test, add one new test)

**Interfaces:**
- Consumes: `coordinationUserIdSchema` from `../coordination/userIdSchema.js` (Task 1).
- Produces: `onConflictRecovery` validates `entry.userId` with `coordinationUserIdSchema` instead of `canonicalUuidSchema`; `entry.workspaceId`/`entry.noteId` stay `canonicalUuidSchema`-validated (unchanged).

- [ ] **Step 1: Fix the now-incorrect negative test FIRST**

In `apps/web/src/pages/WorkbenchPage.test.ts`, find `"does not mount recovery when the session context is not canonical"` (currently uses `context: { userId: "not-a-uuid", workspaceId: CONFLICT_WORKSPACE_ID }` and asserts recovery does NOT mount). Under the relaxed schema, `"not-a-uuid"` becomes a valid `userId`, so recovery WOULD mount, breaking this assertion. Change the test's `context.workspaceId` to an invalid value instead (workspaceId stays canonical-UUID-gated, so this preserves the test's "non-canonical identity blocks recovery" intent):

```ts
it("does not mount recovery when the session context is not canonical", async () => {
  const sessionFactory: WorkbenchSessionFactory = vi.fn(async () => ({
    session: {} as EditorSession,
    context: { userId: USER_ID, workspaceId: "not-a-uuid" },
  }));
  // ... rest of the test body is unchanged (mount, click, assert `.exists()` is `false`)
});
```

(Use whatever valid `userId` fixture constant the file already defines, e.g. an existing `USER_ID` constant used elsewhere in this file — do not invent a new one if one already exists.)

- [ ] **Step 2: Run to verify it still passes with the old code (workspaceId was always canonical-gated)**

Run: `pnpm --filter @glyphquire/web exec vitest run src/pages/WorkbenchPage.test.ts -t "does not mount recovery when the session context is not canonical"`
Expected: PASS — this confirms the test still exercises real rejection (via workspaceId) before touching userId's schema.

- [ ] **Step 3: Write the failing test proving an opaque userId now works**

Add a new test in the same file, in the same `describe` block:

```ts
it("mounts recovery with an opaque, non-UUID userId (real better-auth ids are not UUIDs)", async () => {
  const sessionFactory: WorkbenchSessionFactory = vi.fn(async () => ({
    session: {} as EditorSession,
    context: { userId: "usr_2N4kQb8fVxErq7wZ", workspaceId: CONFLICT_WORKSPACE_ID },
  }));
  const wrapper = mount(WorkbenchPage, {
    props: { sessionFactory },
    global: {
      plugins: [createPinia()],
      stubs: {
        Workbench: ConflictWorkbenchStub(),
        ConflictWorkspace: ConflictWorkspaceStub(),
      },
    },
  });

  await wrapper.get('button[aria-label="Open conflict recovery"]').trigger("click");
  await flushPromises();

  expect(wrapper.find('[aria-label="Resolve conflicting edits"]').exists()).toBe(true);
  wrapper.unmount();
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/pages/WorkbenchPage.test.ts -t "mounts recovery with an opaque"`
Expected: FAIL — `canonicalUuidSchema` still rejects the opaque userId.

- [ ] **Step 5: Relax the schema check**

In `apps/web/src/pages/WorkbenchPage.vue`, add the import and change the `userId` check in `onConflictRecovery`:

```ts
import { coordinationUserIdSchema } from "../coordination/userIdSchema.js";
```

```ts
function onConflictRecovery(
  entry: Omit<ActiveConflict, "localBaseRevision"> & { localBaseRevision: number | null },
): void {
  if (!coordinationUserIdSchema.safeParse(entry.userId).success) return;
  if (!canonicalUuidSchema.safeParse(entry.workspaceId).success) return;
  if (!canonicalUuidSchema.safeParse(entry.noteId).success) return;
  conflictStore.report(entry);
}
```

(Only the first line's schema changes; `workspaceId`/`noteId` checks are unchanged.)

- [ ] **Step 6: Run the full WorkbenchPage suite to verify everything passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/pages/WorkbenchPage.test.ts`
Expected: PASS, all tests.

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/pages/WorkbenchPage.vue apps/web/src/pages/WorkbenchPage.test.ts`
Expected: clean.

- [ ] **Step 8: Full web suite (final regression guard for this expanded plan)**

Run: `pnpm --filter @glyphquire/web test`
Expected: PASS, full suite green, no regressions anywhere in the app.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/pages/WorkbenchPage.vue apps/web/src/pages/WorkbenchPage.test.ts
git commit -m "feat: accept opaque non-UUID userId in conflict recovery"
```

---

## Plan Expansion History (pre-approval security review)

A first, narrower draft of this plan covered only Tasks 1–3 (`coordinationUserIdSchema`, `noteScopeSchema`, `liveBrowserSessionSchema`). A read-only security review of that draft found it internally sound (colon-delimited naming stays collision-free, no authorization bypass — see "Security Review Dispositions" below) but found the stated blast radius understated: three more sites on the identical critical path still gate real users on `canonicalUuidSchema`-for-`userId`, plus one independent, pre-existing concurrency-correctness bug on the same code path. Both were confirmed by direct code reading (not assumed) and folded into this plan as Tasks 4–7, per explicit user decision, so the main Layer C plan is built on a genuinely complete foundation rather than one with known, documented gaps.

## Security Review Dispositions (pre-approval)

Read-only security review verdict on Tasks 1–3: **sound, approvable as scoped** — the `:`-exclusion in `coordinationUserIdSchema` makes `${prefix}:${userId}:${workspaceId}:${noteId}`-style names collision-free (workspace/note ids are fixed-format UUIDs that never contain `:`, so no component can inject the delimiter); `userId` is used only for local equality comparison and delimited naming, never as a server-facing authorization credential (server-side enforcement, verified in Layer A, remains the real boundary); the one now-incorrect negative test was correctly identified and its fix verified sound.

Additional findings from the same review, dispositioned by explicit user decision:
- **P1 — `DraftStore.ts` still gates `userId` on `canonicalUuidSchema` in `draftKeySchema`/`clearForUser`, directly on the `openEditorSession`/`endUserLocally` critical path this plan targets:** FIX → Task 5.
- **P1 — `endUserLocally` marks `endedUsers` before `draftStore.clearForUser` is known to have succeeded, so a failure is silently unretryable and a departed user's local drafts can be left unswept (independent of id format — any `clearForUser` failure triggers this):** FIX → Task 4. Scoped narrowly: the marker is moved to only be set on the success path; a full retry-entry-point feature is out of scope (no public API currently re-invokes `endUserLocally` for the same departing user, so there is nothing further to expose safely here without a separate, larger design).
- **P2 — `AuthenticatedWorkbenchHost.ts`'s `assertCanonicalIdentity` hard-throws for a non-UUID `userId`, which would break every real authenticated workbench mount:** FIX → Task 6.
- **P2 — `WorkbenchPage.vue`'s `onConflictRecovery` silently drops a real user's conflict-recovery report for a non-UUID `userId` (data-loss-adjacent, no visible error):** FIX → Task 7.
- **P4 (style/DRY) — `coordinationUserIdSchema` reimplements `opaqueAuthIdSchema`'s byte-bounding logic instead of composing it:** DEFER. Left as a self-contained, colon-aware schema in `apps/web` to avoid adding a new cross-package coupling for a single small utility; revisit only if the shared bound in `@glyphquire/api-contract` ever changes and drift becomes a real risk.

A second security review of the added Tasks 4–7 confirmed them **sound, no P0–P2**, and validated: the `::`-delimited `draftRecordId` stays collision-free for the same colon-exclusion reason as Tasks 1–3; `assertOpaqueUserIdentity` changes no behavior beyond the identity-format check; `WorkbenchPage`'s conflict-recovery `userId` is a local echo of the already-validated host identity (never attacker/server-controlled), so relaxing its redundant check opens no injection path; and every negative-test fix (Tasks 3/5/6/7) swaps a UUID-only-invalid fixture for a genuinely-still-invalid one rather than weakening the assertion. Two P3 notes on Task 4 were dispositioned: (1) the "Why" text was corrected to accurately describe the reachable overlapping-`logout()` retry path (the fix is more consequential than the first draft stated, not less); (2) Task 4 Step 1's test honestly guards throw-on-failure but does not exercise the retry timing — a stronger overlapping-retry test is recorded as a deferred P4 follow-up in Task 4 Step 3 rather than forced in as a potentially-flaky concurrency test.

## Notes for the Reviewer / Verifier

- **Why this is a real, pre-existing bug, not speculative:** `openEditorSession` (`EditorSession.ts:777`) does `noteScopeSchema.parse({ userId: validated.userId, ... })` with `deps.userId` typed as `string` (`EditorSessionDeps.userId: string`, `editor-session.types.ts:103`) — nothing upstream constrains it to a UUID. Once a real `WorkbenchSessionFactory` (Layer C proper) passes the authenticated `actorId` (opaque better-auth text, confirmed via `packages/database/src/schema/auth.ts:4` `user.id = text("id")`) into these deps, every real user's first editor session would throw at this line — before this plan, with no clear error message. The same actorId also flows through `AuthenticatedWorkbenchHost` (Task 6) before a session factory is even invoked, through `DraftStore` (Task 5) on every draft read/write, and appears in conflict-recovery reports (Task 7). This plan closes all of these gaps before Layer C's session factory is built on top of them.
- **Blast radius was empirically checked at every site**, not assumed: `TabChannel.test.ts` and `NoteLock.test.ts` use canonical-UUID `userId` fixtures only as positive values (no `"must be a UUID"` negative assertions) — grepped and confirmed. `SessionLifecycleCoordinator.test.ts`, `AuthenticatedWorkbenchHost.test.ts`, and `WorkbenchPage.test.ts` each have exactly one negative assertion depending on the old UUID-only behavior — each located and fixed in its task (Task 3 Step 1, Task 6 Step 1, Task 7 Step 1 respectively). `EditorSession.test.ts` has no userId-format negative assertions — grepped and confirmed. `DraftStore.test.ts` is checked live in Task 5 Step 1 (its exact current content wasn't read while drafting this plan; the step instructs finding and fixing any such assertion before proceeding, the same pattern already proven correct three times over in this plan).
- **Security property preserved:** the relaxed schema still rejects the empty string, oversized values, and — specifically to protect the `:`- and `::`-delimited lock/channel/draft naming schemes — any value containing `:`. `workspaceId`/`noteId` remain full canonical-UUID validation throughout every task; only the identity component that was always going to be an opaque auth id changes, at every site where it changes.
- **Task 4 is independent of Tasks 1–3, 5–7** in the sense that it fixes a bug reachable regardless of `userId` format — it is included here because it was discovered on this plan's critical path during review, not because it depends on the schema relaxation. It can be reviewed and verified on its own success-path-preserving merits.
