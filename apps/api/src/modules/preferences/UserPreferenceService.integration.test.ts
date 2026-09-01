import { randomUUID } from "node:crypto";
import {
  createDb,
  themes,
  user,
  userPreferences,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UserPreferenceServiceImpl, type UserPreferenceService } from "./UserPreferenceService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("UserPreferenceService", () => {
  let db: Database;
  let service: UserPreferenceService;
  let actorA: string;
  let actorB: string;
  let systemThemeId: string;
  let workspaceThemeId: string;

  beforeAll(() => {
    db = createDb(databaseUrl!);
    service = new UserPreferenceServiceImpl(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  beforeEach(async () => {
    actorA = `preference-a-${randomUUID()}`;
    actorB = `preference-b-${randomUUID()}`;
    await db.insert(user).values([
      { id: actorA, name: "Preference A", email: `${actorA}@example.test` },
      { id: actorB, name: "Preference B", email: `${actorB}@example.test` },
    ]);
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: "Personal", personalOwnerId: actorA })
      .returning({ id: workspaces.id });
    const insertedThemes = await db
      .insert(themes)
      .values([
        {
          name: `Preference system ${randomUUID()}`,
          version: "1.0.0",
          isSystem: true,
        },
        {
          workspaceId: workspace!.id,
          name: `Preference workspace ${randomUUID()}`,
          version: "1.0.0",
          isSystem: false,
        },
      ])
      .returning({ id: themes.id, isSystem: themes.isSystem });
    systemThemeId = insertedThemes.find((theme) => theme.isSystem)!.id;
    workspaceThemeId = insertedThemes.find((theme) => !theme.isSystem)!.id;
  });

  it("returns stable defaults without creating a row", async () => {
    await expect(service.getThemePreference(actorA)).resolves.toEqual({
      themeId: null,
      mode: "light",
      customOverrides: {},
      variantOverrides: {},
      revision: 0,
      updatedAt: "1970-01-01T00:00:00.000Z",
    });

    const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, actorA));
    expect(rows).toHaveLength(0);
  });

  it("inserts at base revision zero and uses exact CAS for later writes", async () => {
    const created = await service.putThemePreference(actorA, {
      themeId: systemThemeId,
      mode: "dark",
      customOverrides: { color: { background: "#111827" } },
      variantOverrides: { quote: { variant: "paper" } },
      baseRevision: 0,
    });
    expect(created).toMatchObject({ themeId: systemThemeId, mode: "dark", revision: 1 });

    const updated = await service.putThemePreference(actorA, {
      themeId: null,
      mode: "light",
      customOverrides: {},
      variantOverrides: {},
      baseRevision: 1,
    });
    expect(updated).toMatchObject({ themeId: null, mode: "light", revision: 2 });

    await expect(
      service.putThemePreference(actorA, {
        themeId: systemThemeId,
        mode: "dark",
        customOverrides: {},
        variantOverrides: {},
        baseRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", status: 409 });
  });

  it("isolates preferences by authenticated actor", async () => {
    await service.putThemePreference(actorA, {
      themeId: systemThemeId,
      mode: "dark",
      customOverrides: {},
      variantOverrides: {},
      baseRevision: 0,
    });
    await service.putThemePreference(actorB, {
      themeId: null,
      mode: "light",
      customOverrides: {},
      variantOverrides: {},
      baseRevision: 0,
    });

    expect(await service.getThemePreference(actorA)).toMatchObject({
      themeId: systemThemeId,
      mode: "dark",
    });
    expect(await service.getThemePreference(actorB)).toMatchObject({
      themeId: null,
      mode: "light",
    });
  });

  it("rejects workspace themes without writing preference state", async () => {
    await expect(
      service.putThemePreference(actorA, {
        themeId: workspaceThemeId,
        mode: "dark",
        customOverrides: {},
        variantOverrides: {},
        baseRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_INVALID", status: 400 });

    const rows = await db
      .select()
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, actorA), eq(userPreferences.revision, 1)));
    expect(rows).toHaveLength(0);
  });
});
