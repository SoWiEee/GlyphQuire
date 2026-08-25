import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, user, workspaces, workspaceMembers, type Database } from "@glyphquire/database";
import { ThemeServiceImpl, type ThemeService } from "./ThemeService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("ThemeService", () => {
  let db: Database;
  let service: ThemeService;
  let testUserId: string;
  let testWorkspaceId: string;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    service = new ThemeServiceImpl(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  beforeEach(async () => {
    const id = `theme-test-${crypto.randomUUID()}`;
    await db.insert(user).values({ id, name: "Test User", email: `${id}@test.com` });
    testUserId = id;
    const [ws] = await db
      .insert(workspaces)
      .values({ personalOwnerId: testUserId })
      .returning({ id: workspaces.id });
    testWorkspaceId = ws!.id;
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: testWorkspaceId, userId: testUserId, role: "owner" });
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
