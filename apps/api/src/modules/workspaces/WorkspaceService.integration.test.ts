import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, createDb, user, workspaceMembers, type Database } from "@glyphquire/database";
import { createAuth } from "@glyphquire/auth";
import { createApp } from "../../app.js";
import { WorkspaceService } from "./WorkspaceService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const describeWithMigrationPostgres = migrationDatabaseUrl ? describe : describe.skip;
const baseUrl = "http://localhost:3000";
const authSecret = "integration-only-secret-at-least-32-characters";
const credentialPasswordHash =
  "94c9f555be93e894924615c0b2bae671:f711b1d1ba1270ac984d224d5f74efe5aa8426c01658b6e8904018c5336c4181b6b3d5bbf5eab91eeea7b151e8b9f55d6d844af847a2891102ab2062d69bcc3f";

function actorId() {
  return `workspace-test-${randomUUID()}`;
}

async function insertActor(db: Database, id = actorId()) {
  await db.insert(user).values({
    id,
    name: "Workspace Test",
    email: `${id}@example.test`,
  });
  return id;
}

async function personalRows(db: Database, id: string) {
  const actorWorkspaces = await db.query.workspaces.findMany({
    where: (table, { eq }) => eq(table.personalOwnerId, id),
  });
  const memberships = await db.query.workspaceMembers.findMany({
    where: (table, { eq }) => eq(table.userId, id),
  });
  return { actorWorkspaces, memberships };
}

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
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
    },
    body: JSON.stringify({
      name: "New User",
      email,
      password: "correct-horse-battery-staple",
    }),
  });
}

function signInRequest(email: string) {
  return new Request(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
    },
    body: JSON.stringify({
      email,
      password: "correct-horse-battery-staple",
    }),
  });
}

function cookieFrom(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";", 1)[0]!;
}

describeWithPostgres("WorkspaceService", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("idempotently returns one Personal owner workspace", async () => {
    const id = await insertActor(db);
    const service = new WorkspaceService(db);

    const first = await service.ensurePersonalWorkspace(id);
    const second = await service.ensurePersonalWorkspace(id);
    const rows = await personalRows(db, id);

    expect(first).toEqual({ id: second.id, name: "Personal", role: "owner" });
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(rows.actorWorkspaces).toHaveLength(1);
    expect(rows.memberships).toHaveLength(1);
    expect(rows.memberships[0]).toMatchObject({
      workspaceId: first.id,
      userId: id,
      role: "owner",
    });
  });

  it("is race-safe under concurrent provisioning", async () => {
    const id = await insertActor(db);
    const service = new WorkspaceService(db);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => service.ensurePersonalWorkspace(id)),
    );
    const rows = await personalRows(db, id);

    expect(new Set(results.map((result) => result.id))).toHaveLength(1);
    expect(rows.actorWorkspaces).toHaveLength(1);
    expect(rows.memberships).toHaveLength(1);
    expect(rows.memberships[0]?.role).toBe("owner");
  });

  it("rolls back the workspace when membership provisioning fails", async () => {
    const id = await insertActor(db);
    const service = new WorkspaceService(db, {
      afterWorkspaceInserted() {
        throw new Error("injected membership failure");
      },
    });

    await expect(service.ensurePersonalWorkspace(id)).rejects.toThrow(
      "injected membership failure",
    );
    expect(await personalRows(db, id)).toEqual({
      actorWorkspaces: [],
      memberships: [],
    });
  });

  it("rejects roles outside owner, editor, and viewer", async () => {
    const id = await insertActor(db);
    const service = new WorkspaceService(db);
    const workspace = await service.ensurePersonalWorkspace(id);

    try {
      await db.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: id,
        role: "administrator" as "owner",
      });
      expect.unreachable("invalid workspace role should be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { cause?: unknown }).cause).toMatchObject({
        code: "23514",
        constraint_name: "workspace_members_role_check",
      });
    }
  });

  it("enforces issuer-scoped account identity uniqueness", async () => {
    const id = await insertActor(db);
    const identity = {
      accountId: id,
      issuer: "local:credential",
      providerId: "credential",
      userId: id,
    };

    await db.insert(account).values({ id: `account-${randomUUID()}`, ...identity });
    try {
      await db.insert(account).values({ id: `account-${randomUUID()}`, ...identity });
      expect.unreachable("duplicate issuer/account identity should be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { cause?: unknown }).cause).toMatchObject({
        code: "23505",
        constraint_name: "account_issuer_accountId_uidx",
      });
    }
  });

  it("provisions a Personal workspace before registration reports success", async () => {
    const email = `registration-${randomUUID()}@example.test`;
    const service = new WorkspaceService(db);
    const app = createApp(appEnv(databaseUrl!), { db, workspaceService: service });

    const response = await app.request(registrationRequest(email));
    const createdUser = await db.query.user.findFirst({
      where: (table, { eq }) => eq(table.email, email),
    });
    const createdAccount = createdUser
      ? await db.query.account.findFirst({
          columns: { issuer: true },
          where: (table, { eq }) => eq(table.userId, createdUser.id),
        })
      : undefined;

    expect(response.status).toBe(200);
    expect(createdUser).toBeDefined();
    expect(createdAccount?.issuer).toBe("local:credential");
    expect((await personalRows(db, createdUser!.id)).actorWorkspaces).toHaveLength(1);
  });

  it("returns SERVICE_UNAVAILABLE after auth commit and repairs on first authenticated use", async () => {
    const email = `repair-${randomUUID()}@example.test`;
    const failingService = new WorkspaceService(db, {
      afterWorkspaceInserted() {
        throw new Error("injected registration provisioning failure");
      },
    });
    const failingApp = createApp(appEnv(databaseUrl!), {
      db,
      workspaceService: failingService,
    });

    const registration = await failingApp.request(registrationRequest(email));
    const registrationBody = (await registration.json()) as { code?: string };
    const createdUser = await db.query.user.findFirst({
      where: (table, { eq }) => eq(table.email, email),
    });

    expect(registration.status).toBe(503);
    expect(registrationBody.code).toBe("SERVICE_UNAVAILABLE");
    expect(createdUser).toBeDefined();
    expect(await personalRows(db, createdUser!.id)).toEqual({
      actorWorkspaces: [],
      memberships: [],
    });

    const healthyService = new WorkspaceService(db);
    const healthyApp = createApp(appEnv(databaseUrl!), {
      db,
      workspaceService: healthyService,
    });
    const signIn = await healthyApp.request(signInRequest(email));
    expect(signIn.status).toBe(200);

    const firstUse = await healthyApp.request(`${baseUrl}/api/v1/not-yet-mounted`, {
      headers: { cookie: cookieFrom(signIn) },
    });
    const repaired = await personalRows(db, createdUser!.id);

    expect(firstUse.status).toBe(404);
    expect(repaired.actorWorkspaces).toHaveLength(1);
    expect(repaired.memberships).toHaveLength(1);
  });

  it("backfills a pre-existing user on the first authenticated /api/v1 request", async () => {
    const email = `legacy-${randomUUID()}@example.test`;
    const legacyAuth = createAuth(db, {
      baseUrl,
      secret: authSecret,
      async onUserCreated() {},
    });
    const registration = await legacyAuth.handler(registrationRequest(email));
    expect(registration.status).toBe(200);

    const createdUser = await db.query.user.findFirst({
      where: (table, { eq }) => eq(table.email, email),
    });
    expect(createdUser).toBeDefined();
    expect((await personalRows(db, createdUser!.id)).actorWorkspaces).toHaveLength(0);

    const service = new WorkspaceService(db);
    const app = createApp(appEnv(databaseUrl!), { db, workspaceService: service });
    await app.request(`${baseUrl}/api/v1/not-yet-mounted`, {
      headers: { cookie: cookieFrom(registration) },
    });

    const repaired = await personalRows(db, createdUser!.id);
    expect(repaired.actorWorkspaces).toHaveLength(1);
    expect(repaired.memberships).toHaveLength(1);
  });
});

describeWithMigrationPostgres("Phase 0 credential upgrade", () => {
  let adminDb: Database;
  const databases = new Set<string>();

  beforeAll(() => {
    adminDb = createDb(migrationDatabaseUrl!);
  });

  afterAll(async () => {
    for (const databaseName of databases) {
      await adminDb.$client`
        select pg_catalog.pg_terminate_backend(activity.pid)
        from pg_catalog.pg_stat_activity activity
        where activity.datname = ${databaseName}
          and activity.pid <> pg_catalog.pg_backend_pid()
      `;
      await adminDb.$client.unsafe(`drop database "${databaseName}"`);
    }
    await adminDb.$client.end();
  });

  it("captures broken pre-0001 signup, then upgrades trusted credentials", async () => {
    const databaseName = `glyphquire_t2_api_${randomUUID().replaceAll("-", "")}`;
    expect(databaseName).toMatch(/^[a-z0-9_]+$/);
    await adminDb.$client.unsafe(`create database "${databaseName}"`);
    databases.add(databaseName);

    const targetUrl = new URL(migrationDatabaseUrl!);
    targetUrl.pathname = `/${databaseName}`;
    const targetDb = createDb(targetUrl.toString());
    const email = `phase0-${randomUUID()}@example.test`;
    const incompatibleSignupEmail = `phase0-signup-${randomUUID()}@example.test`;
    const userId = `phase0-${randomUUID()}`;

    try {
      const phase0Source = await readFile(
        new URL(
          "../../../../../packages/database/src/migrations/0000_phase0_auth.sql",
          import.meta.url,
        ),
        "utf8",
      );
      for (const statement of phase0Source.split("--> statement-breakpoint")) {
        if (statement.trim()) await targetDb.$client.unsafe(statement);
      }

      const phase0Auth = createAuth(targetDb, {
        baseUrl,
        secret: authSecret,
        async onUserCreated() {},
      });
      const incompatibleSignup = await phase0Auth.handler(
        registrationRequest(incompatibleSignupEmail),
      );
      const orphanedUser = await targetDb.query.user.findFirst({
        where: (table, { eq }) => eq(table.email, incompatibleSignupEmail),
      });
      expect(incompatibleSignup.status).toBe(500);
      expect(orphanedUser).toBeDefined();
      const [orphanedAccountCount] = await targetDb.$client<{ count: number }[]>`
        select count(*)::integer as count
        from account
        where user_id = ${orphanedUser!.id}
      `;
      expect(orphanedAccountCount?.count).toBe(0);

      await targetDb.$client`
        insert into "user" (id, name, email)
        values (${userId}, 'Phase 0 User', ${email})
      `;
      await targetDb.$client`
        insert into account (id, account_id, provider_id, user_id, password)
        values (
          ${`account-${randomUUID()}`},
          ${userId},
          'credential',
          ${userId},
          ${credentialPasswordHash}
        )
      `;
      const phase2Source = await readFile(
        new URL(
          "../../../../../packages/database/src/migrations/0001_phase2_workspaces.sql",
          import.meta.url,
        ),
        "utf8",
      );
      for (const statement of phase2Source.split("--> statement-breakpoint")) {
        if (statement.trim()) await targetDb.$client.unsafe(statement);
      }

      const auth = createAuth(targetDb, {
        baseUrl,
        secret: authSecret,
        async onUserCreated() {},
      });
      const response = await auth.handler(signInRequest(email));
      const [identity] = await targetDb.$client<{ issuer: string }[]>`
        select issuer from account where user_id = ${userId}
      `;

      expect(response.status).toBe(200);
      expect(identity?.issuer).toBe("local:credential");
    } finally {
      await targetDb.$client.end();
    }
  });
});
