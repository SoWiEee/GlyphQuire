import {
  putThemePreferenceInputSchema,
  themePreferenceResultSchema,
  type PutThemePreferenceInput,
  type ThemePreferenceResult,
} from "@glyphquire/api-contract";
import { themes, userPreferences, type Database } from "@glyphquire/database";
import { and, eq, isNull } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";

const DEFAULT_THEME_PREFERENCE: ThemePreferenceResult = {
  themeId: null,
  mode: "light",
  customOverrides: {},
  variantOverrides: {},
  revision: 0,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export interface UserPreferenceService {
  getThemePreference(actorId: string): Promise<ThemePreferenceResult>;
  putThemePreference(
    actorId: string,
    input: PutThemePreferenceInput,
  ): Promise<ThemePreferenceResult>;
}

function toResult(row: typeof userPreferences.$inferSelect): ThemePreferenceResult {
  return themePreferenceResultSchema.parse({
    themeId: row.themeId,
    mode: row.mode,
    customOverrides: row.customOverrides,
    variantOverrides: row.variantOverrides,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export class UserPreferenceServiceImpl implements UserPreferenceService {
  constructor(private readonly db: Database) {}

  async getThemePreference(actorId: string): Promise<ThemePreferenceResult> {
    const [row] = await this.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, actorId))
      .limit(1);
    return row ? toResult(row) : { ...DEFAULT_THEME_PREFERENCE };
  }

  async putThemePreference(
    actorId: string,
    input: PutThemePreferenceInput,
  ): Promise<ThemePreferenceResult> {
    const parsed = putThemePreferenceInputSchema.safeParse(input);
    if (!parsed.success) throw new PublicApiError("DOCUMENT_INVALID", 400);
    const preference = parsed.data;
    await this.requireSystemTheme(preference.themeId);

    if (preference.baseRevision === 0) {
      const [row] = await this.db
        .insert(userPreferences)
        .values({
          userId: actorId,
          themeId: preference.themeId,
          mode: preference.mode,
          customOverrides: preference.customOverrides,
          variantOverrides: preference.variantOverrides,
          revision: 1,
        })
        .onConflictDoNothing({ target: userPreferences.userId })
        .returning();
      if (!row) throw new PublicApiError("REVISION_CONFLICT", 409);
      return toResult(row);
    }

    const [row] = await this.db
      .update(userPreferences)
      .set({
        themeId: preference.themeId,
        mode: preference.mode,
        customOverrides: preference.customOverrides,
        variantOverrides: preference.variantOverrides,
        revision: preference.baseRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userPreferences.userId, actorId),
          eq(userPreferences.revision, preference.baseRevision),
        ),
      )
      .returning();
    if (!row) throw new PublicApiError("REVISION_CONFLICT", 409);
    return toResult(row);
  }

  private async requireSystemTheme(themeId: string | null): Promise<void> {
    if (themeId === null) return;
    const [theme] = await this.db
      .select({ id: themes.id })
      .from(themes)
      .where(and(eq(themes.id, themeId), eq(themes.isSystem, true), isNull(themes.workspaceId)))
      .limit(1);
    if (!theme) throw new PublicApiError("DOCUMENT_INVALID", 400);
  }
}
