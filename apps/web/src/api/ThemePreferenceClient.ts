import {
  themeListResultSchema,
  themePreferenceResultSchema,
  putThemePreferenceInputSchema,
  type PutThemePreferenceInput,
  type ThemePreferenceResult,
  type ThemeResult,
} from "@glyphquire/api-contract";

export interface ThemePreferenceClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ThemePreferenceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Theme preference request failed: ${code}`);
    this.name = "ThemePreferenceApiError";
  }
}

export class ThemePreferenceClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ThemePreferenceClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get(): Promise<ThemePreferenceResult> {
    return this.request(
      "/api/v1/me/preferences/theme",
      { method: "GET" },
      themePreferenceResultSchema,
    );
  }

  async put(input: PutThemePreferenceInput): Promise<ThemePreferenceResult> {
    const payload = putThemePreferenceInputSchema.parse(input);
    return this.request(
      "/api/v1/me/preferences/theme",
      {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      },
      themePreferenceResultSchema,
    );
  }

  async listWorkspaceThemes(workspaceId: string): Promise<ThemeResult[]> {
    const result = await this.request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/themes`,
      { method: "GET" },
      themeListResultSchema,
    );
    return result.items;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        credentials: "include",
        headers: { accept: "application/json", ...init.headers },
      });
    } catch (error) {
      throw new ThemePreferenceApiError(0, error instanceof Error ? error.message : "network");
    }
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      try {
        const body = (await response.json()) as { error?: { code?: string } };
        code = body.error?.code ?? code;
      } catch {
        // Keep the status-only code when the server returned no JSON envelope.
      }
      throw new ThemePreferenceApiError(response.status, code);
    }
    return schema.parse(await response.json());
  }
}
