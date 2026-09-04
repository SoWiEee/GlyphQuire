import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "@glyphquire/database";
import { createApp, type AppType } from "./app.js";

// Full-stack login -> edit -> save E2E against the LIVE database.
// Exercises the exact chain the frontend drives: better-auth sign-up (cookie
// session), GET /api/v1/me (Layer A), create note, save edited content (CAS),
// read the note back to confirm persistence. Runs in-process via createApp so
// it uses the real assembled middleware chain + real Postgres.

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const baseUrl = "http://localhost:3000";
const authSecret = "e2e-integration-secret-at-least-32-characters-long";

function appEnv(url: string) {
  return {
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: baseUrl,
    API_PORT: 3000,
    WEB_PORT: 5173,
    WEB_ORIGIN: "http://localhost:5173",
  };
}

function signUpRequest(email: string) {
  return new Request(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ name: "E2E User", email, password: "correct-horse-battery-staple" }),
  });
}

function cookieFrom(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";", 1)[0]!;
}

function v1(app: AppType, path: string, cookie: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", "http://localhost:5173");
  headers.set("cookie", cookie);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return app.request(`${baseUrl}/api/v1${path}`, { ...init, headers });
}

describeWithPostgres("E2E: login -> edit -> save (live DB)", () => {
  let db: Database;
  beforeAll(() => {
    db = createDb(databaseUrl!);
  });
  afterAll(async () => {
    await db.$client.end();
  });

  it("registers, discovers the workspace, creates a note, saves an edit, and reads it back", async () => {
    const app = createApp(appEnv(databaseUrl!), { db });
    const email = `e2e-${randomUUID()}@example.test`;

    // 1. Sign in (register) — real better-auth, sets the session cookie.
    const signUp = await app.request(signUpRequest(email));
    expect(signUp.status).toBe(200);
    const cookie = cookieFrom(signUp);

    // 2. Discover the personal workspace (Layer A /me).
    const meResponse = await v1(app, "/me", cookie);
    expect(meResponse.status).toBe(200);
    const me = (await meResponse.json()) as { userId: string; personalWorkspaceId: string };
    expect(me.userId).toBeTruthy();
    expect(me.personalWorkspaceId).toMatch(/^[0-9a-f-]{36}$/);

    // 3. Create a note in that workspace.
    const createResponse = await v1(app, `/workspaces/${me.personalWorkspaceId}/notes`, cookie, {
      method: "POST",
      body: JSON.stringify({
        operationId: randomUUID(),
        title: "E2E note",
        contentMarkdown: "",
        visibility: "private",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { id: string; revision: number };

    // 4. Save an edit (CAS on the current revision) — the autosave path.
    const editedMarkdown = "# Edited by E2E\n\nThis content was saved live.";
    const saveResponse = await v1(app, `/notes/${created.id}/content`, cookie, {
      method: "PUT",
      body: JSON.stringify({
        operationId: randomUUID(),
        baseRevision: created.revision,
        contentMarkdown: editedMarkdown,
      }),
    });
    expect(saveResponse.status).toBe(200);
    const saved = (await saveResponse.json()) as { revision: number; contentMarkdown: string };
    expect(saved.revision).toBe(created.revision + 1);

    // 5. Read it back — the edit persisted in Postgres.
    const getResponse = await v1(app, `/notes/${created.id}`, cookie);
    expect(getResponse.status).toBe(200);
    const fetched = (await getResponse.json()) as { contentMarkdown: string; revision: number };
    expect(fetched.contentMarkdown).toBe(editedMarkdown);
    expect(fetched.revision).toBe(created.revision + 1);
  });
});
