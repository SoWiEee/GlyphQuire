import { themes, userThemes, workspaceMembers, type Database } from "@glyphquire/database";
import type {
  CreateThemeInput,
  UpdateThemeInput,
  SetUserThemeInput,
  ThemeResult,
  ThemeListResult,
  UserThemeResult,
} from "@glyphquire/api-contract";
import {
  resolveTheme,
  tokensToCssVariables,
  defaultTheme,
  type ThemeTokens,
} from "@glyphquire/theme-engine";
import { and, eq, isNull, or } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";

export interface ThemeService {
  list(actorId: string, workspaceId: string): Promise<ThemeListResult>;
  create(actorId: string, workspaceId: string, input: CreateThemeInput): Promise<ThemeResult>;
  get(actorId: string, themeId: string): Promise<ThemeResult>;
  update(actorId: string, themeId: string, input: UpdateThemeInput): Promise<ThemeResult>;
  remove(actorId: string, themeId: string): Promise<void>;
  getUserTheme(actorId: string, workspaceId: string): Promise<UserThemeResult>;
  setUserTheme(
    actorId: string,
    workspaceId: string,
    input: SetUserThemeInput,
  ): Promise<UserThemeResult>;
}

function toResult(row: typeof themes.$inferSelect): ThemeResult {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    version: row.version,
    tokens: row.tokens as Record<string, unknown>,
    darkTokens: row.darkTokens as Record<string, unknown> | null,
    components: row.components as Record<string, unknown> | null,
    isSystem: row.isSystem,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ThemeServiceImpl implements ThemeService {
  constructor(private readonly db: Database) {}

  private async requireMembership(actorId: string, workspaceId: string): Promise<void> {
    const [member] = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)),
      )
      .limit(1);
    if (!member) throw new PublicApiError("NOTE_NOT_FOUND", 404);
  }

  async list(actorId: string, workspaceId: string): Promise<ThemeListResult> {
    await this.requireMembership(actorId, workspaceId);
    const rows = await this.db
      .select()
      .from(themes)
      .where(or(eq(themes.workspaceId, workspaceId), isNull(themes.workspaceId)));
    return { items: rows.map(toResult) };
  }

  async create(
    actorId: string,
    workspaceId: string,
    input: CreateThemeInput,
  ): Promise<ThemeResult> {
    await this.requireMembership(actorId, workspaceId);
    const [row] = await this.db
      .insert(themes)
      .values({
        workspaceId,
        name: input.name,
        version: input.version,
        tokens: input.tokens ?? {},
        darkTokens: input.darkTokens ?? null,
        components: input.components ?? null,
        isSystem: false,
      })
      .returning();
    if (!row) throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    return toResult(row);
  }

  async get(actorId: string, themeId: string): Promise<ThemeResult> {
    const [row] = await this.db.select().from(themes).where(eq(themes.id, themeId)).limit(1);
    if (!row) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    if (row.workspaceId) await this.requireMembership(actorId, row.workspaceId);
    return toResult(row);
  }

  async update(actorId: string, themeId: string, input: UpdateThemeInput): Promise<ThemeResult> {
    const [existing] = await this.db.select().from(themes).where(eq(themes.id, themeId)).limit(1);
    if (!existing) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    if (existing.isSystem) throw new PublicApiError("DOCUMENT_INVALID", 400);
    if (!existing.workspaceId) throw new PublicApiError("DOCUMENT_INVALID", 400);
    await this.requireMembership(actorId, existing.workspaceId);

    if (existing.revision !== input.baseRevision) {
      throw new PublicApiError("REVISION_CONFLICT", 409);
    }

    const updates: Record<string, unknown> = {
      revision: existing.revision + 1,
      updatedAt: new Date(),
    };
    if (input.name !== undefined) updates.name = input.name;
    if (input.version !== undefined) updates.version = input.version;
    if (input.tokens !== undefined) updates.tokens = input.tokens;
    if (input.darkTokens !== undefined) updates.darkTokens = input.darkTokens;
    if (input.components !== undefined) updates.components = input.components;

    const [row] = await this.db
      .update(themes)
      .set(updates)
      .where(and(eq(themes.id, themeId), eq(themes.revision, input.baseRevision)))
      .returning();
    if (!row) throw new PublicApiError("REVISION_CONFLICT", 409);
    return toResult(row);
  }

  async remove(actorId: string, themeId: string): Promise<void> {
    const [existing] = await this.db.select().from(themes).where(eq(themes.id, themeId)).limit(1);
    if (!existing) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    if (existing.isSystem) throw new PublicApiError("DOCUMENT_INVALID", 400);
    if (!existing.workspaceId) throw new PublicApiError("DOCUMENT_INVALID", 400);
    await this.requireMembership(actorId, existing.workspaceId);
    await this.db.delete(themes).where(eq(themes.id, themeId));
  }

  async getUserTheme(actorId: string, workspaceId: string): Promise<UserThemeResult> {
    await this.requireMembership(actorId, workspaceId);
    const [ut] = await this.db
      .select()
      .from(userThemes)
      .where(and(eq(userThemes.userId, actorId), eq(userThemes.workspaceId, workspaceId)))
      .limit(1);

    let themeRow: typeof themes.$inferSelect;
    if (ut) {
      const [t] = await this.db.select().from(themes).where(eq(themes.id, ut.themeId)).limit(1);
      if (!t) throw new PublicApiError("NOTE_NOT_FOUND", 404);
      themeRow = t;
    } else {
      const [t] = await this.db
        .select()
        .from(themes)
        .where(and(eq(themes.isSystem, true), eq(themes.name, "Default Light")))
        .limit(1);
      if (!t) throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
      themeRow = t;
    }

    const baseTokens = (themeRow.tokens ?? {}) as Partial<ThemeTokens>;
    const overrides = (ut?.customOverrides ?? {}) as Partial<ThemeTokens>;
    const resolved = resolveTheme(defaultTheme, { ...baseTokens, ...overrides });
    const cssVars = tokensToCssVariables(resolved);

    return {
      themeId: themeRow.id,
      theme: toResult(themeRow),
      customOverrides: (ut?.customOverrides as Record<string, unknown>) ?? null,
      resolvedTokens: cssVars,
    };
  }

  async setUserTheme(
    actorId: string,
    workspaceId: string,
    input: SetUserThemeInput,
  ): Promise<UserThemeResult> {
    await this.requireMembership(actorId, workspaceId);
    const [themeRow] = await this.db
      .select()
      .from(themes)
      .where(eq(themes.id, input.themeId))
      .limit(1);
    if (!themeRow) throw new PublicApiError("NOTE_NOT_FOUND", 404);

    const [existing] = await this.db
      .select()
      .from(userThemes)
      .where(and(eq(userThemes.userId, actorId), eq(userThemes.workspaceId, workspaceId)))
      .limit(1);

    if (existing) {
      await this.db
        .update(userThemes)
        .set({
          themeId: input.themeId,
          customOverrides: input.customOverrides ?? null,
          updatedAt: new Date(),
        })
        .where(eq(userThemes.id, existing.id));
    } else {
      await this.db.insert(userThemes).values({
        userId: actorId,
        workspaceId,
        themeId: input.themeId,
        customOverrides: input.customOverrides ?? null,
      });
    }

    return this.getUserTheme(actorId, workspaceId);
  }
}
