# Frontend Auth + Workspace Bootstrap + Editable Real Notes

**Status:** Design proposal — pending user review before planning.

**Goal:** Connect the already-built GlyphQuire frontend shell to the
authenticated backend so a signed-in user reaches their personal workspace,
sees their real notes in the workbench, and can create and edit them with the
existing autosave machinery — replacing the current demo-only experience.

**Spec origin:** Follow-on from the UI/UX improvements (items 1/4/5 shipped).
Items 2 (real notes in workbench) and 3 (recent-notes landing) were blocked by
the absence of any frontend authentication or workspace bootstrap; this spec
covers that foundation and the two features that build on it.

---

## 1. Current State and the Gap

Verified by inspection of the codebase:

**Backend — complete and unchanged by this work except where noted:**
- better-auth is fully wired at `/api/auth/*` (sign-up, sign-in, session,
  sign-out), cookie-based session.
- On user creation and on every `/api/v1/*` request the server runs
  `ensurePersonalWorkspace(actorId)`, so a signed-in user always has a personal
  workspace server-side.
- Full notes API exists: `GET /api/v1/workspaces/:workspaceId/notes` (list),
  `POST` (create), `GET /api/v1/notes/:noteId` (single note with
  `contentMarkdown` + `revision`), title/content/delete/restore, versions.

**Frontend — the disconnected shell:**
- `LoginPage` / `RegisterPage` are non-functional stubs (`@submit.prevent`,
  no handler). No session store, no router guard, no better-auth client usage.
- `packages/auth` already exports `createAuthClient(baseUrl)` wrapping
  `better-auth/client` — unused by the app.
- `NoteClient` / `useNotesStore` fully implement note list/create/rename/
  delete/restore against the API with `credentials: "same-origin"`.
- The workbench runs on in-memory `DEFAULT_NOTES` demo data.
  `provideAuthenticatedWorkbenchHost` (the real bridge) and `NoteExplorer`
  (the real notes UI) are not mounted anywhere in production.
- All editing machinery exists and is unit-tested but unwired into a
  production session factory: `openEditorSession(deps)`, `NoteLock`,
  `BrowserSessionLifecycleCoordinator`, `IndexedDbDraftStore`,
  `AutosaveController`, `DocumentWorkerClient`.

**The single blocking gap:** no endpoint returns the current user's personal
workspace id. Every workspace-scoped route requires a `:workspaceId` the caller
must already know. After login the frontend has a session cookie (userId) but
no way to discover which workspace to open.

Dev server proxies `/api` → `http://localhost:3000`, so the frontend is
same-origin with the API; cookie session and `credentials: "same-origin"`
work without CORS.

---

## 2. Architecture

Three layers, built in order. Each is independently testable.

```
Layer A (backend)   GET /api/v1/me  ──► { userId, personalWorkspaceId, email }
Layer B (frontend)  session store + Login/Register wiring + router guard
                    + bootstrap: on auth, fetch /me → workspaceId → route
Layer C (frontend)  production WorkbenchSessionFactory + real notes in Explorer
                    (list / create / inline search / editable) + recent-notes Home
```

Layer A is the only backend change and is security-sensitive (authz). Layer C
reuses the existing editing machinery — it is wiring, not new autosave logic.

---

## 3. Layer A — Backend `GET /api/v1/me`

**Contract** (new file `packages/api-contract/src/me/schemas.ts`, exported via
the contract index):

```
GET /api/v1/me
200 → {
  userId: canonicalUuid,
  personalWorkspaceId: canonicalUuid,
  email: string,           // from the authenticated session
}
```

- Authenticated like every other `/api/v1/*` route (session required; 401/404
  scrubbed per existing error-handler conventions when no session).
- Returns only the caller's own identity and personal workspace — never another
  user's. The personal workspace is resolved through the existing
  `WorkspaceService` / `ensurePersonalWorkspace` path, so the id is guaranteed
  to exist and belong to the caller.
- No new authorization surface: it exposes strictly what the caller already is.

**Route:** new `apps/api/src/routes/v1/me.ts` mounted in `app.ts` alongside the
other v1 routes, using the existing `getRequestContext(context).actorId`.
Because `ensurePersonalWorkspace` already runs in the `/api/v1/*` middleware
chain, the handler resolves the workspace id for `actorId` and returns it.

**Service:** extend `WorkspaceService` with a read that returns the caller's
personal workspace id (the provisioner already knows how to find/create it).

**Tests:** contract test (shape/strictness), integration test (authenticated
request returns the caller's own workspace id; unauthenticated is rejected;
a second user cannot obtain the first user's workspace).

---

## 4. Layer B — Frontend Session + Bootstrap

**Auth client base URL:** same-origin. `createAuthClient` is given a base
resolved against `window.location.origin` (auth handler lives at `/api/auth`).
No secret is bundled (better-auth client is public by design).

**Session store** — new Pinia store `apps/web/src/stores/session.ts`:

```
state:  status: "unknown" | "authenticated" | "anonymous"
        userId, personalWorkspaceId, email, error
actions:
  signIn(email, password)      → better-auth signIn.email, then bootstrap()
  signUp(email, password, name)→ better-auth signUp.email, then bootstrap()
  signOut()                    → better-auth signOut, clear state → /login
  bootstrap()                  → getSession(); if authed, GET /api/v1/me →
                                 fill userId/personalWorkspaceId/email
  restore()                    → called once at app start to hydrate status
```

A `MeClient` (new `apps/web/src/api/MeClient.ts`, same transport pattern as
`NoteClient`, same-origin) calls `GET /api/v1/me`.

**Login/Register wiring:** bind the existing form fields to the store actions,
surface `error` inline in plain language, disable the submit button while a
request is in flight. On success, route to the workspace (see guard).

**Router guard** (`router/index.ts` `beforeEach`):
- Ensure the session is restored once before the first navigation resolves.
- `authenticated` user hitting `/login` or `/register` → redirect to
  `/workspace/:personalWorkspaceId`.
- `anonymous` user hitting a protected route (`/`, `/workspace/...`) →
  redirect to `/login`.
- `/` for an authenticated user → redirect to
  `/workspace/:personalWorkspaceId` (this is also Layer C / Task 3's default;
  the recent-notes landing renders at `/` only if we keep a landing — see §6).
- Session expiry (a `/api/v1/*` call returns 401 / `getSession` empty) →
  reset store to `anonymous` and route to `/login`.

---

## 5. Layer C — Real Notes in the Workbench (Task 2) + Recent Notes (Task 3)

### 5.1 Production `WorkbenchSessionFactory`

New `apps/web/src/providers/workbenchSessionFactory.ts` builds a
`WorkbenchSessionFactory` by wiring existing pieces. For a given
`WorkbenchNote` it:

1. Resolves `userId` + `workspaceId` from the session store.
2. Loads the note's current content: `NoteClient.getNote(noteId)` →
   `contentMarkdown` + `revision` (initialMarkdown / initialRevision).
3. Constructs deps and calls `openEditorSession`:
   `{ userId, workspaceId, noteId, initialRevision, initialMarkdown,
      noteClient, draftStore: IndexedDbDraftStore, noteLock: new NoteLock(scope),
      sessionLifecycle: BrowserSessionLifecycleCoordinator,
      documentAnalysis: DocumentWorkerClient }`.
4. Returns `{ session, context: { userId, workspaceId, workspaceName,
   accountLabel } }`.

`WorkbenchPage` / `AppLayout` calls `provideAuthenticatedWorkbenchHost` with
this factory and the session's identity, replacing the empty
`provideWorkbenchHostContext({})`.

The `welcome`/`roadmap`/`scratch` DEFAULT_NOTES demo data is removed from the
production path (kept only as a test/storybook fixture if needed).

### 5.2 Real notes in the Explorer (Task 2)

`ExplorerPane` is backed by `useNotesStore` for the active workspace:
- On workspace load, `notesStore.loadWorkspace(workspaceId)` populates the list.
- The Explorer renders `notesStore.activeNotes` (real titles), highlighting the
  active note.
- **New note:** a header `+ New note` button → `notesStore.create(title)` →
  opens the created note in the workbench (real persistence).
- **Inline search:** a filter input at the top filters the displayed list by
  title client-side (no backend round-trip).
- Selecting a note opens it as a workbench tab; the session factory loads its
  content and grants editing with autosave.

The workbench's note model bridges `NoteSummary` (store) ↔ `WorkbenchNote`
(shell): the shell holds `{ id, title }`; content is loaded lazily by the
session factory on open, so the list does not need every note's markdown.

Rename / delete / restore / trash already exist in `NoteExplorer.vue` and
`useNotesStore`; this task reuses that logic (either by mounting the richer
NoteExplorer in the workbench or by porting its create/rename/delete affordances
into ExplorerPane — the plan decides which, favoring reuse).

### 5.3 Recent-notes landing (Task 3)

`HomePage` (rendered at `/` for an authenticated user, if we keep a landing)
lists the user's most recently updated notes from `useNotesStore` (sorted by
`updatedAt` desc, capped), each linking into
`/workspace/:workspaceId?noteId=...`, plus a `+ New note` CTA. If §4's guard
instead redirects `/` straight to the workspace, Task 3 becomes a "Recent"
panel inside the workspace rather than a separate page — the plan picks one;
default recommendation: redirect `/` → workspace and surface Recent inside the
Explorer, avoiding a second navigation.

---

## 6. Security Considerations

- `GET /api/v1/me` returns only the caller's own identity/workspace; add an
  integration test proving user B cannot read user A's workspace id.
- Session stays in httpOnly cookies (better-auth) — never mirrored into
  `localStorage`. The session store holds only non-secret identity
  (userId, workspaceId, email).
- All requests same-origin with `credentials: "same-origin"`; no token handling
  in JS, no secret in the bundle.
- Authorization is enforced server-side on every note route (unchanged); the
  frontend guard is UX gating, not a security boundary.
- Draft content in IndexedDB is per-note local recovery state (existing
  behavior); no new sensitive data is persisted client-side.
- Sign-out clears session state and local session-scoped caches and routes to
  `/login`.

## 7. Failure / State UX

- Login/register errors: inline, plain-language message; never leak whether the
  email exists beyond what better-auth already returns.
- Offline / session expiry mid-session: existing autosave `offline`/`error`/
  `conflict` states already surface in the workbench; a 401 resets to
  `anonymous` and routes to `/login` with a "your session ended" notice.
- Bootstrap failure (`/me` unreachable) after a valid session: show a
  retryable error rather than a blank workspace.

## 8. Testing Strategy

- **Backend:** contract + integration tests for `/api/v1/me` (auth required,
  own-workspace-only, shape).
- **Session store:** unit tests with a fake auth client + fake MeClient
  (signIn success/failure, signOut, bootstrap fills workspace, expiry resets).
- **Router guard:** tests for each redirect branch (anon→login,
  authed-on-login→workspace, `/`→workspace, expiry→login).
- **Session factory:** unit test wiring with fakes (getNote → openEditorSession
  called with correct deps; failure paths fail closed).
- **Explorer real notes:** create → appears + opens; inline search filters;
  selecting loads content.
- **Recent notes:** sorted/capped list renders and links correctly.
- Keep the existing web suite green; no changes to autosave/session logic.

## 9. Acceptance Criteria

- A new user can register, is taken to their personal workspace, creates a
  note, edits it, and sees it autosave (`Saving → Saved`) — all against the
  real backend.
- Returning users sign in and land in their workspace with their real notes.
- The Explorer lists real notes, supports New note and inline search.
- `/api/v1/me` never discloses another user's workspace; unauthenticated access
  is rejected.
- Sign-out returns to `/login`; a protected route while anonymous redirects to
  `/login`.
- Existing web + api test suites stay green; no autosave/session-logic changes.

## 10. Out of Scope

- Multiple workspaces per user / workspace switching (model has personal only).
- Password reset, email verification flows, OAuth providers (unless already in
  better-auth config; not wired in UI here).
- Real-time multi-user presence beyond the existing single-writer lock.
- The larger note-editing session already exists; this spec wires it, it does
  not redesign autosave, locking, or conflict recovery.
