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
import { PostgresSearchAdapter, normalizeSearchText } from "@glyphquire/search";
import { Hono, type Context } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppRuntime } from "../../app.js";
import { createErrorHandler } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import { createOperatorAuthorizer } from "../../modules/search/OperatorAuthorizer.js";
import { SearchServiceImpl } from "../../modules/search/SearchService.js";
import { createSearchRoutes } from "./search.js";

// SearchService's own membership authorization, cursor/nextCursor
// derivation, and operator-authorization plumbing are covered in
// ../../modules/search/SearchService.integration.test.ts and
// search-operator.integration.test.ts. This file exercises the HTTP seam
// for GET /api/v1/search: query-string parsing, route mounting, and status
// codes observed at the boundary.

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
  searchService: SearchServiceImpl,
  operatorAuthorizer: ReturnType<typeof createOperatorAuthorizer>,
) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler())
    .route("/api/v1", createSearchRoutes(searchService, operatorAuthorizer));
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

describeWithPostgres("search routes", () => {
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
    const owner = await insertActor("search-route-owner");
    const outsider = await insertActor("search-route-outsider");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace!.id, userId: owner, role: "owner" });
    return { owner, outsider, workspaceId: workspace!.id };
  }

  function freshApp() {
    const dispatcher = new FakeJobDispatcher();
    const adapter = new PostgresSearchAdapter(db);
    const operatorAuthorizer = createOperatorAuthorizer([]);
    const service = new SearchServiceImpl(db, adapter, dispatcher, operatorAuthorizer);
    return { app: buildApp(service, operatorAuthorizer), adapter };
  }

  it("registers both Task 3 search endpoints on the real application runtime", async () => {
    const runtime = createAppRuntime(
      {
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: "search-route-registration-secret-at-least-32-characters",
        BETTER_AUTH_URL: "http://localhost:3000",
        WEB_ORIGIN: "http://localhost:5173",
      },
      { db },
    );
    try {
      const routes = runtime.app.routes.map((route) => `${route.method} ${route.path}`);
      expect(routes).toContain("GET /api/v1/search");
      expect(routes).toContain("POST /api/v1/workspaces/:workspaceId/notes/:noteId/search-rebuild");
    } finally {
      await runtime.close();
    }
  });

  it("finds an indexed note through the mounted GET /search route", async () => {
    const fixture = await buildFixture();
    const { app, adapter } = freshApp();
    const marker = randomUUID().replaceAll("-", "");

    const [note] = await db
      .insert(notes)
      .values({
        workspaceId: fixture.workspaceId,
        title: `Route note ${marker}`,
        contentMarkdown: `Route note ${marker}`,
        contentHash: "hash",
        ownerId: fixture.owner,
      })
      .returning({ id: notes.id });
    await adapter.indexNote({
      noteId: note!.id,
      workspaceId: fixture.workspaceId,
      revision: 1,
      title: `Route note ${marker}`,
      headings: [],
      body: `Route note ${marker}`,
      tags: [],
      normalizedText: normalizeSearchText(`Route note ${marker}`),
    });

    const response = await v1(
      app,
      `/search?workspaceId=${fixture.workspaceId}&q=${marker}`,
      fixture.owner,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { noteId: string }[];
      nextCursor: string | null;
    };
    expect(body.items.map((item) => item.noteId)).toEqual([note!.id]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns a uniform not-found envelope for a non-member, without leaking membership state", async () => {
    const fixture = await buildFixture();
    const { app } = freshApp();

    const response = await v1(
      app,
      `/search?workspaceId=${fixture.workspaceId}&q=anything`,
      fixture.outsider,
    );
    expect(response.status).toBe(404);
    const envelope = (await response.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("NOTE_NOT_FOUND");
  });

  it("rejects a missing q parameter with a contract-validation error", async () => {
    const fixture = await buildFixture();
    const { app } = freshApp();

    const response = await v1(app, `/search?workspaceId=${fixture.workspaceId}`, fixture.owner);
    expect(response.status).toBe(400);
  });

  it("rejects a whitespace-only q instead of turning it into an unbounded match", async () => {
    const fixture = await buildFixture();
    const { app } = freshApp();

    const response = await v1(
      app,
      `/search?workspaceId=${fixture.workspaceId}&q=%20%09%20`,
      fixture.owner,
    );
    expect(response.status).toBe(400);
  });

  it("rejects unknown and duplicate query parameters instead of silently ignoring them", async () => {
    const fixture = await buildFixture();
    const { app } = freshApp();

    const unknownParameter = await v1(
      app,
      `/search?workspaceId=${fixture.workspaceId}&q=anything&scope=workspace`,
      fixture.owner,
    );
    const duplicateParameter = await v1(
      app,
      `/search?workspaceId=${fixture.workspaceId}&q=anything&q=other`,
      fixture.owner,
    );

    expect(unknownParameter.status).toBe(400);
    expect(duplicateParameter.status).toBe(400);
  });

  it("rejects a malformed workspaceId query parameter", async () => {
    const { app } = freshApp();
    const response = await v1(
      app,
      "/search?workspaceId=not-a-uuid&q=anything",
      await insertActor("search-route-random"),
    );
    expect(response.status).toBe(400);
  });
});
