import { randomUUID } from "node:crypto";
import {
  createDb,
  notes,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import type { EnqueueJobInput, JobDispatcher, JobRegistry } from "@glyphquire/queue";
import { PostgresSearchAdapter } from "@glyphquire/search";
import { Hono, type Context } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createErrorHandler, type SecurityLogger } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../../modules/search/OperatorAuthorizer.js";
import { SearchServiceImpl, type SearchService } from "../../modules/search/SearchService.js";
import { createSearchRoutes } from "./search.js";

// Exercises the operator-only bounded one-note rebuild route over HTTP:
// normal members (including editors) are denied exactly like a missing
// resource, an exact configured operator is allowed and gets a bounded
// scope:"note", batchSize:1 job enqueued, and an empty/misconfigured
// operator allowlist denies everyone. OperatorAuthorizer's own exact-match
// and fail-closed semantics are covered directly in
// ../../modules/search/search-privilege.integration.test.ts; this file
// only asserts the route wiring and HTTP-visible behavior.

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const baseUrl = "http://localhost:3000";

class FakeJobDispatcher implements JobDispatcher {
  readonly enqueued: EnqueueJobInput<never>[] = [];

  async enqueue<TType extends never>(
    input: EnqueueJobInput<TType>,
  ): Promise<{ id: string; duplicate: boolean }> {
    this.enqueued.push(input as EnqueueJobInput<never>);
    return { id: randomUUID(), duplicate: false };
  }

  async dispatchBatch(_registry: JobRegistry) {
    return { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0 };
  }
}

function testAuthMiddleware() {
  return async (context: Context<{ Variables: SecurityVariables }>, next: () => Promise<void>) => {
    const actorId = context.req.header("x-test-actor-id");
    if (!actorId) return context.json({ error: { code: "NOTE_NOT_FOUND" } }, 404);
    context.set("requestContext", {
      requestId: randomUUID(),
      actorId,
      session: {} as never,
    });
    await next();
  };
}

function buildApp(
  searchService: SearchService,
  operatorAuthorizer: OperatorAuthorizer,
  logger?: SecurityLogger,
) {
  const routes = createSearchRoutes(searchService, operatorAuthorizer);
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler(logger))
    .route("/api/v1", routes);
}

function v1(
  app: ReturnType<typeof buildApp>,
  path: string,
  actorId: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("x-test-actor-id", actorId);
  return app.request(`${baseUrl}/api/v1${path}`, { ...init, headers });
}

describeWithPostgres("search rebuild operator route", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function insertActor(prefix: string) {
    const id = `${prefix}-${randomUUID()}`;
    await db.insert(user).values({ id, name: prefix, email: `${id}@example.test` });
    return id;
  }

  async function buildFixture() {
    const owner = await insertActor("rebuild-owner");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace!.id, userId: owner, role: "owner" });
    const [note] = await db
      .insert(notes)
      .values({
        workspaceId: workspace!.id,
        title: "Rebuild target",
        contentMarkdown: "Rebuild target",
        contentHash: "hash",
        ownerId: owner,
      })
      .returning({ id: notes.id });
    return { owner, workspaceId: workspace!.id, noteId: note!.id };
  }

  function freshApp(operatorIds: readonly string[], logger?: SecurityLogger) {
    const dispatcher = new FakeJobDispatcher();
    const adapter = new PostgresSearchAdapter(db);
    const operatorAuthorizer = createOperatorAuthorizer(operatorIds);
    const service = new SearchServiceImpl(db, adapter, dispatcher, operatorAuthorizer);
    return { app: buildApp(service, operatorAuthorizer, logger), dispatcher };
  }

  it("enforces operator authorization in route middleware even if a service omits the check", async () => {
    const fixture = await buildFixture();
    const rebuildNote = vi.fn().mockResolvedValue({ enqueued: true });
    const bypassableService: SearchService = {
      search: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      rebuildNote,
    };
    const app = buildApp(bypassableService, createOperatorAuthorizer([]));

    const response = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes/${fixture.noteId}/search-rebuild`,
      fixture.owner,
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(rebuildNote).not.toHaveBeenCalled();
  });

  it("denies the workspace owner — owning the workspace does not grant operator access", async () => {
    const fixture = await buildFixture();
    const { app, dispatcher } = freshApp([]);

    const response = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes/${fixture.noteId}/search-rebuild`,
      fixture.owner,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    const envelope = (await response.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("NOTE_NOT_FOUND");
    expect(dispatcher.enqueued).toEqual([]);
  });

  it("denies an editor of the workspace exactly like any other non-operator", async () => {
    const fixture = await buildFixture();
    const editor = await insertActor("rebuild-editor");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: fixture.workspaceId, userId: editor, role: "editor" });
    const { app, dispatcher } = freshApp([]);

    const response = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes/${fixture.noteId}/search-rebuild`,
      editor,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(dispatcher.enqueued).toEqual([]);
  });

  it("allows an exact configured operator and enqueues a bounded scope:note rebuild job", async () => {
    const fixture = await buildFixture();
    const operatorId = await insertActor("rebuild-operator");
    const { app, dispatcher } = freshApp([operatorId]);

    const response = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes/${fixture.noteId}/search-rebuild?cursor=one-note-cursor`,
      operatorId,
      { method: "POST" },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { enqueued: boolean };
    expect(body.enqueued).toBe(true);
    expect(dispatcher.enqueued).toHaveLength(1);
    expect(dispatcher.enqueued[0]).toMatchObject({
      type: "search.rebuild",
      payload: {
        workspaceId: fixture.workspaceId,
        scope: "note",
        noteId: fixture.noteId,
        batchSize: 1,
        cursor: "one-note-cursor",
      },
    });
  });

  it("rejects a workspace rebuild branch instead of ignoring unbounded parameters", async () => {
    const fixture = await buildFixture();
    const operatorId = await insertActor("rebuild-workspace-branch-operator");
    const { app, dispatcher } = freshApp([operatorId]);

    const response = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes/${fixture.noteId}/search-rebuild?scope=workspace&batchSize=100`,
      operatorId,
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    expect(dispatcher.enqueued).toEqual([]);
  });

  it("denies every actor, including a plausible operator id, when the allowlist is empty", async () => {
    const fixture = await buildFixture();
    const wouldBeOperator = await insertActor("rebuild-wouldbe-operator");
    const { app, dispatcher } = freshApp([]);

    const response = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes/${fixture.noteId}/search-rebuild`,
      wouldBeOperator,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(dispatcher.enqueued).toEqual([]);
  });

  it("fails closed on a malformed allowlist and audits denial without actor-id leakage", async () => {
    const fixture = await buildFixture();
    const wouldBeOperator = await insertActor("rebuild-malformed-operator");
    const entries: unknown[] = [];
    const logger: SecurityLogger = { error: (entry) => entries.push(entry) };
    const { app, dispatcher } = freshApp([wouldBeOperator, "malformed id"], logger);

    const response = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes/${fixture.noteId}/search-rebuild`,
      wouldBeOperator,
      { method: "POST" },
    );
    const serialized = JSON.stringify({ body: await response.json(), entries });

    expect(response.status).toBe(404);
    expect(dispatcher.enqueued).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(serialized).not.toContain(wouldBeOperator);
  });

  it("rejects a malformed noteId path parameter for an exact configured operator", async () => {
    const fixture = await buildFixture();
    const operatorId = await insertActor("rebuild-malformed-note-operator");
    const { app } = freshApp([operatorId]);

    const response = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/notes/not-a-uuid/search-rebuild`,
      operatorId,
      { method: "POST" },
    );
    expect(response.status).toBe(400);
  });
});
