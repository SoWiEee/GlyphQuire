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
