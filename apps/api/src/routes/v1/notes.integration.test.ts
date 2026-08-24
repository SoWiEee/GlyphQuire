import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, workspaceMembers, type Database } from "@glyphquire/database";
import { createApp, type AppType } from "../../app.js";

// Deep authorization-matrix, transaction-atomicity, idempotency, and
// cursor-determinism coverage lives in
// ../../modules/notes/NoteService.integration.test.ts. This file exercises
// the HTTP wiring: route mounting, contract parsing, status codes, and the
// uniform error envelope observed at the boundary.

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

function v1(app: AppType, path: string, cookie: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", baseUrl);
  headers.set("cookie", cookie);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return app.request(`${baseUrl}/api/v1${path}`, { ...init, headers });
}

describeWithPostgres("note routes", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  // Each test gets its own app instance (and thus its own in-memory rate
  // limiter) so registering the fixture's actors in one test never trips the
  // auth rate limit shared by a prior test.
  function freshApp() {
    return createApp(appEnv(databaseUrl!), { db });
  }

  async function buildFixture(app: AppType) {
    const owner = await registerActor(app, db, "owner");
    const editor = await registerActor(app, db, "editor");
    const viewer = await registerActor(app, db, "viewer");
    const outsider = await registerActor(app, db, "outsider");

    const ownerWorkspace = await db.query.workspaces.findFirst({
      where: (table, { eq }) => eq(table.personalOwnerId, owner.userId),
    });
    if (!ownerWorkspace) throw new Error("owner's personal workspace was not provisioned");

    await db.insert(workspaceMembers).values([
      { workspaceId: ownerWorkspace.id, userId: editor.userId, role: "editor" },
      { workspaceId: ownerWorkspace.id, userId: viewer.userId, role: "viewer" },
    ]);

    return { owner, editor, viewer, outsider, workspaceId: ownerWorkspace.id };
  }

  it("drives create, list, get, rename, soft delete, and restore through the mounted routes", async () => {
    const app = freshApp();
    const fixture = await buildFixture(app);

    const createResponse = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes`,
      fixture.owner.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          operationId: randomUUID(),
          title: "First note",
          contentMarkdown: "# Hello",
          visibility: "private",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      id: string;
      revision: number;
      title: string;
    };
    expect(created.title).toBe("First note");
    expect(created.revision).toBe(1);

    const listResponse = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes`,
      fixture.owner.cookie,
    );
    expect(listResponse.status).toBe(200);
    const page = (await listResponse.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(page.items.map((item) => item.id)).toContain(created.id);

    const getResponse = await v1(app, `/notes/${created.id}`, fixture.editor.cookie);
    expect(getResponse.status).toBe(200);

    const renameResponse = await v1(app, `/notes/${created.id}/title`, fixture.editor.cookie, {
      method: "PATCH",
      body: JSON.stringify({
        operationId: randomUUID(),
        baseRevision: created.revision,
        title: "Renamed",
      }),
    });
    expect(renameResponse.status).toBe(200);
    const renamed = (await renameResponse.json()) as { revision: number; title: string };
    expect(renamed.title).toBe("Renamed");
    expect(renamed.revision).toBe(created.revision + 1);

    const deleteResponse = await v1(app, `/notes/${created.id}`, fixture.owner.cookie, {
      method: "DELETE",
      body: JSON.stringify({ operationId: randomUUID(), baseRevision: renamed.revision }),
    });
    expect(deleteResponse.status).toBe(200);
    const deleted = (await deleteResponse.json()) as { deletedAt: string | null; revision: number };
    expect(deleted.deletedAt).not.toBeNull();

    const afterDeleteGet = await v1(app, `/notes/${created.id}`, fixture.owner.cookie);
    expect(afterDeleteGet.status).toBe(404);

    const restoreResponse = await v1(app, `/notes/${created.id}/restore`, fixture.owner.cookie, {
      method: "POST",
      body: JSON.stringify({ operationId: randomUUID(), baseRevision: deleted.revision }),
    });
    expect(restoreResponse.status).toBe(200);
    const restored = (await restoreResponse.json()) as { deletedAt: string | null };
    expect(restored.deletedAt).toBeNull();
  });

  it("returns a uniform NOTE_NOT_FOUND envelope for an outsider and for a viewer's mutation, without leaking content", async () => {
    const app = freshApp();
    const fixture = await buildFixture(app);
    const createResponse = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes`,
      fixture.owner.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          operationId: randomUUID(),
          title: "Confidential Title",
          contentMarkdown: "# Confidential body",
          visibility: "private",
        }),
      },
    );
    const created = (await createResponse.json()) as { id: string; revision: number };

    const outsiderGet = await v1(app, `/notes/${created.id}`, fixture.outsider.cookie);
    expect(outsiderGet.status).toBe(404);
    const outsiderBody = (await outsiderGet.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(outsiderBody.error.code).toBe("NOTE_NOT_FOUND");
    expect(JSON.stringify(outsiderBody)).not.toContain("Confidential");

    const viewerRename = await v1(app, `/notes/${created.id}/title`, fixture.viewer.cookie, {
      method: "PATCH",
      body: JSON.stringify({
        operationId: randomUUID(),
        baseRevision: created.revision,
        title: "Viewer attempt",
      }),
    });
    expect(viewerRename.status).toBe(404);
    const viewerBody = (await viewerRename.json()) as { error: { code: string; message: string } };
    expect(viewerBody.error.code).toBe("NOTE_NOT_FOUND");

    // The outsider (no membership) and the viewer (membership, but read-only)
    // get the same status and code: neither response distinguishes "does not
    // exist" from "exists but you may not act on it". Only requestId, which
    // is per-request by design, differs.
    expect(viewerRename.status).toBe(outsiderGet.status);
    expect(viewerBody.error.code).toBe(outsiderBody.error.code);
    expect(viewerBody.error.message).toBe(outsiderBody.error.message);
  });

  it("rejects a request body that fails contract validation with DOCUMENT_INVALID", async () => {
    const app = freshApp();
    const fixture = await buildFixture(app);

    const missingOperationId = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes`,
      fixture.owner.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          title: "No operation id",
          contentMarkdown: "# body",
          visibility: "private",
        }),
      },
    );
    expect(missingOperationId.status).toBe(400);
    const invalidBody = (await missingOperationId.json()) as { error: { code: string } };
    expect(invalidBody.error.code).toBe("DOCUMENT_INVALID");

    const oversizedTitle = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes`,
      fixture.owner.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          operationId: randomUUID(),
          title: "x".repeat(201),
          contentMarkdown: "# body",
          visibility: "private",
        }),
      },
    );
    expect(oversizedTitle.status).toBe(400);
  });

  it("paginates deterministically over the wire via the cursor query parameter", async () => {
    const app = freshApp();
    const fixture = await buildFixture(app);
    const createdIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await v1(
        app,
        `/workspaces/${fixture.workspaceId}/notes`,
        fixture.owner.cookie,
        {
          method: "POST",
          body: JSON.stringify({
            operationId: randomUUID(),
            title: `Page note ${index}`,
            contentMarkdown: "# body",
            visibility: "private",
          }),
        },
      );
      const note = (await response.json()) as { id: string };
      createdIds.push(note.id);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const query = cursor ? `?pageSize=1&cursor=${encodeURIComponent(cursor)}` : "?pageSize=1";
      const response = await v1(
        app,
        `/workspaces/${fixture.workspaceId}/notes${query}`,
        fixture.owner.cookie,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      expect(page.items).toHaveLength(1);
      collected.push(page.items[0]!.id);
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 10);

    for (const id of createdIds) {
      expect(collected).toContain(id);
    }
    expect(new Set(collected).size).toBe(collected.length);
  });
});
