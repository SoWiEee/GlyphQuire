import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, workspaceMembers, type Database } from "@glyphquire/database";
import { createApp, type AppType } from "../../app.js";

// Deep transaction-atomicity, snapshot-policy, concurrency, and restore
// semantics coverage lives in
// ../../modules/notes/NoteWriter.integration.test.ts. This file exercises
// the HTTP wiring for save/checkpoint/version routes: route mounting,
// contract parsing, status codes, and the rich save-conflict envelope
// observed at the boundary.

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

interface CreatedNote {
  id: string;
  revision: number;
  contentMarkdown: string;
}

describeWithPostgres("version and save routes", () => {
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

  async function createNote(app: AppType, cookie: string, workspaceId: string): Promise<CreatedNote> {
    const response = await v1(app, `/workspaces/${workspaceId}/notes`, cookie, {
      method: "POST",
      body: JSON.stringify({
        operationId: randomUUID(),
        title: "Untitled",
        contentMarkdown: "# Original",
        visibility: "private",
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as CreatedNote;
  }

  it("drives save, checkpoint, list/preview, and restore through the mounted routes", async () => {
    const app = freshApp();
    const fixture = await buildFixture(app);
    const note = await createNote(app, fixture.owner.cookie, fixture.workspaceId);

    const saveResponse = await v1(app, `/notes/${note.id}/content`, fixture.editor.cookie, {
      method: "PUT",
      body: JSON.stringify({
        operationId: randomUUID(),
        baseRevision: note.revision,
        contentMarkdown: "# Edited by editor",
      }),
    });
    expect(saveResponse.status).toBe(200);
    const saved = (await saveResponse.json()) as CreatedNote;
    expect(saved.contentMarkdown).toBe("# Edited by editor");
    expect(saved.revision).toBe(note.revision + 1);

    const checkpointResponse = await v1(
      app,
      `/notes/${note.id}/versions/checkpoint`,
      fixture.owner.cookie,
      { method: "POST", body: JSON.stringify({ operationId: randomUUID(), baseRevision: saved.revision }) },
    );
    expect(checkpointResponse.status).toBe(200);
    const checkpointed = (await checkpointResponse.json()) as {
      note: CreatedNote;
      version: { id: string; revision: number; reason: string; createdBy: { displayName: string } };
    };
    expect(checkpointed.version.reason).toBe("checkpoint");
    expect(checkpointed.version.createdBy.displayName).toBe("New User");
    expect(checkpointed.note.revision).toBe(saved.revision + 1);

    const listResponse = await v1(app, `/notes/${note.id}/versions`, fixture.viewer.cookie);
    expect(listResponse.status).toBe(200);
    const page = (await listResponse.json()) as { items: { id: string; revision: number }[] };
    expect(page.items.map((item) => item.id)).toContain(checkpointed.version.id);

    const previewResponse = await v1(
      app,
      `/notes/${note.id}/versions/${checkpointed.version.id}`,
      fixture.viewer.cookie,
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as { contentMarkdown: string };
    expect(preview.contentMarkdown).toBe("# Edited by editor");

    const restoreResponse = await v1(
      app,
      `/notes/${note.id}/versions/${checkpointed.version.id}/restore`,
      fixture.owner.cookie,
      {
        method: "POST",
        body: JSON.stringify({ operationId: randomUUID(), baseRevision: checkpointed.note.revision }),
      },
    );
    expect(restoreResponse.status).toBe(200);
    const restored = (await restoreResponse.json()) as CreatedNote;
    expect(restored.contentMarkdown).toBe("# Edited by editor");
    expect(restored.revision).toBe(checkpointed.note.revision + 1);
  });

  it("returns a rich, request-scoped conflict body on a stale save, never leaking the loser's content", async () => {
    const app = freshApp();
    const fixture = await buildFixture(app);
    const note = await createNote(app, fixture.owner.cookie, fixture.workspaceId);

    const [firstResponse, secondResponse] = await Promise.all([
      v1(app, `/notes/${note.id}/content`, fixture.owner.cookie, {
        method: "PUT",
        body: JSON.stringify({
          operationId: randomUUID(),
          baseRevision: note.revision,
          contentMarkdown: "# Winner",
        }),
      }),
      v1(app, `/notes/${note.id}/content`, fixture.owner.cookie, {
        method: "PUT",
        body: JSON.stringify({
          operationId: randomUUID(),
          baseRevision: note.revision,
          contentMarkdown: "# LOSER-SENTINEL",
        }),
      }),
    ]);

    const statuses = [firstResponse.status, secondResponse.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = firstResponse.status === 200 ? firstResponse : secondResponse;
    const conflictResponse = firstResponse.status === 409 ? firstResponse : secondResponse;

    const winnerBody = (await winner.json()) as CreatedNote & { updatedAt: string };
    const conflictBody = (await conflictResponse.json()) as {
      code: string;
      noteId: string;
      serverRevision: number;
      serverMarkdown: string;
      serverUpdatedAt: string;
      lastEditedBy: { displayName: string } | null;
      requestId: string;
    };

    expect(conflictBody.code).toBe("REVISION_CONFLICT");
    expect(conflictBody.noteId).toBe(note.id);
    expect(conflictBody.serverRevision).toBe(winnerBody.revision);
    expect(conflictBody.serverMarkdown).toBe(winnerBody.contentMarkdown);
    expect(conflictBody.serverUpdatedAt).toBe(winnerBody.updatedAt);
    expect(conflictBody.lastEditedBy).toEqual({ displayName: "New User" });
    expect(typeof conflictBody.requestId).toBe("string");
    expect(conflictBody.requestId.length).toBeGreaterThan(0);
    expect(JSON.stringify(conflictBody)).not.toContain("LOSER-SENTINEL");
  });

  it("returns a uniform NOTE_NOT_FOUND envelope for an outsider and for a viewer's mutation attempt", async () => {
    const app = freshApp();
    const fixture = await buildFixture(app);
    const note = await createNote(app, fixture.owner.cookie, fixture.workspaceId);

    const outsiderSave = await v1(app, `/notes/${note.id}/content`, fixture.outsider.cookie, {
      method: "PUT",
      body: JSON.stringify({
        operationId: randomUUID(),
        baseRevision: note.revision,
        contentMarkdown: "# Outsider attempt",
      }),
    });
    expect(outsiderSave.status).toBe(404);
    const outsiderBody = (await outsiderSave.json()) as { error: { code: string } };
    expect(outsiderBody.error.code).toBe("NOTE_NOT_FOUND");

    const viewerCheckpoint = await v1(
      app,
      `/notes/${note.id}/versions/checkpoint`,
      fixture.viewer.cookie,
      { method: "POST", body: JSON.stringify({ operationId: randomUUID(), baseRevision: note.revision }) },
    );
    expect(viewerCheckpoint.status).toBe(404);
    const viewerBody = (await viewerCheckpoint.json()) as { error: { code: string } };
    expect(viewerBody.error.code).toBe("NOTE_NOT_FOUND");

    // A viewer may still read version history.
    const viewerList = await v1(app, `/notes/${note.id}/versions`, fixture.viewer.cookie);
    expect(viewerList.status).toBe(200);
  });

  it("rejects a save body that fails contract validation with DOCUMENT_INVALID", async () => {
    const app = freshApp();
    const fixture = await buildFixture(app);
    const note = await createNote(app, fixture.owner.cookie, fixture.workspaceId);

    const missingOperationId = await v1(app, `/notes/${note.id}/content`, fixture.owner.cookie, {
      method: "PUT",
      body: JSON.stringify({ baseRevision: note.revision, contentMarkdown: "# body" }),
    });
    expect(missingOperationId.status).toBe(400);
    const body = (await missingOperationId.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DOCUMENT_INVALID");
  });

  it("returns NOTE_NOT_FOUND for a version id that does not belong to the note", async () => {
    const app = freshApp();
    const fixture = await buildFixture(app);
    const noteA = await createNote(app, fixture.owner.cookie, fixture.workspaceId);
    const noteB = await createNote(app, fixture.owner.cookie, fixture.workspaceId);

    const checkpointResponse = await v1(
      app,
      `/notes/${noteB.id}/versions/checkpoint`,
      fixture.owner.cookie,
      { method: "POST", body: JSON.stringify({ operationId: randomUUID(), baseRevision: noteB.revision }) },
    );
    const checkpointed = (await checkpointResponse.json()) as { version: { id: string } };

    const crossNotePreview = await v1(
      app,
      `/notes/${noteA.id}/versions/${checkpointed.version.id}`,
      fixture.owner.cookie,
    );
    expect(crossNotePreview.status).toBe(404);
  });
});
