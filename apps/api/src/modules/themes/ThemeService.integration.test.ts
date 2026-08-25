import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "@glyphquire/database";
import { ThemeServiceImpl, type ThemeService } from "./ThemeService.js";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gq_app:gq_app_dev@localhost:5432/glyphquire_dev";

describe("ThemeService", () => {
  let db: Database;
  let service: ThemeService;
  let testUserId: string;
  let testWorkspaceId: string;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    service = new ThemeServiceImpl(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  beforeEach(async () => {
    const userResult = await db.execute(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Test User', 'theme-test-' || gen_random_uuid() || '@test.com', true, now(), now())
       RETURNING id`,
    );
    testUserId = (userResult[0] as { id: string }).id;
    const wsResult = await db.execute(
      `INSERT INTO workspaces (id, name, owner_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Test WS', '${testUserId}', now(), now()) RETURNING id`,
    );
    testWorkspaceId = (wsResult[0] as { id: string }).id;
    await db.execute(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at)
       VALUES ('${testWorkspaceId}', '${testUserId}', 'owner', now(), now())`,
    );
  });

  it("list returns system themes plus workspace themes", async () => {
    const result = await service.list(testUserId, testWorkspaceId);
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    expect(result.items.some((t) => t.name === "Default Light")).toBe(true);
    expect(result.items.some((t) => t.name === "Default Dark")).toBe(true);
    expect(result.items.some((t) => t.name === "Warm Sepia")).toBe(true);
  });

  it("creates a workspace theme", async () => {
    const created = await service.create(testUserId, testWorkspaceId, {
      operationId: crypto.randomUUID(),
      name: "Custom Theme",
      version: "1.0.0",
      tokens: {
        color: {
          background: "#111",
          foreground: "#eee",
          muted: "#888",
          accent: "#00f",
          border: "#444",
        },
      },
    });
    expect(created.name).toBe("Custom Theme");
    expect(created.isSystem).toBe(false);
    expect(created.workspaceId).toBe(testWorkspaceId);
  });

  it("rejects deletion of system themes", async () => {
    const list = await service.list(testUserId, testWorkspaceId);
    const systemTheme = list.items.find((t) => t.isSystem);
    expect(systemTheme).toBeDefined();
    await expect(service.remove(testUserId, systemTheme!.id)).rejects.toThrow();
  });

  it("update uses CAS with baseRevision", async () => {
    const created = await service.create(testUserId, testWorkspaceId, {
      operationId: crypto.randomUUID(),
      name: "CAS Theme",
      version: "1.0.0",
    });
    const updated = await service.update(testUserId, created.id, {
      operationId: crypto.randomUUID(),
      baseRevision: created.revision,
      name: "Updated CAS Theme",
    });
    expect(updated.revision).toBe(created.revision + 1);
    await expect(
      service.update(testUserId, created.id, {
        operationId: crypto.randomUUID(),
        baseRevision: created.revision,
        name: "Stale update",
      }),
    ).rejects.toThrow();
  });

  it("sets and gets user active theme", async () => {
    const list = await service.list(testUserId, testWorkspaceId);
    const defaultLight = list.items.find((t) => t.name === "Default Light")!;

    await service.setUserTheme(testUserId, testWorkspaceId, {
      themeId: defaultLight.id,
      customOverrides: {
        color: {
          background: "#fafafa",
          foreground: "#1a1a1a",
          muted: "#6b7280",
          accent: "#2563eb",
          border: "#e5e7eb",
        },
      },
    });

    const userTheme = await service.getUserTheme(testUserId, testWorkspaceId);
    expect(userTheme.themeId).toBe(defaultLight.id);
    expect(userTheme.customOverrides).toBeDefined();
    expect(userTheme.resolvedTokens["--gq-color-background"]).toBe("#fafafa");
  });
});
