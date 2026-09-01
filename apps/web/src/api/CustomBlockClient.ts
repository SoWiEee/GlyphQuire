import {
  apiErrorEnvelopeSchema,
  customBlockListResultSchema,
  customBlockRecordSchema,
  customBlockDefinitionSchema,
  type CustomBlockRecord,
} from "@glyphquire/api-contract";
import type { CustomBlockDefinition } from "@glyphquire/theme-sdk";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CustomBlockApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Custom Block request failed: ${code}`);
    this.name = "CustomBlockApiError";
  }
}

export interface CustomBlockClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class CustomBlockClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CustomBlockClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async list(workspaceId: string): Promise<CustomBlockRecord[]> {
    const result = await this.request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/custom-blocks`,
      { method: "GET" },
      customBlockListResultSchema,
    );
    if (result.items.some((item) => item.workspaceId !== workspaceId)) {
      throw new CustomBlockApiError(502, "SERVICE_UNAVAILABLE");
    }
    return result.items;
  }

  create(
    workspaceId: string,
    operationId: string,
    definition: CustomBlockDefinition,
  ): Promise<CustomBlockRecord> {
    return this.request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/custom-blocks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId,
          definition: customBlockDefinitionSchema.parse(definition),
        }),
      },
      customBlockRecordSchema,
    );
  }

  updateDraft(
    blockId: string,
    operationId: string,
    baseRevision: number,
    definition: CustomBlockDefinition,
  ): Promise<CustomBlockRecord> {
    return this.request(
      `/api/v1/custom-blocks/${encodeURIComponent(blockId)}/draft`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId,
          baseRevision,
          definition: customBlockDefinitionSchema.parse(definition),
        }),
      },
      customBlockRecordSchema,
    );
  }

  publish(blockId: string, operationId: string, baseRevision: number): Promise<CustomBlockRecord> {
    return this.request(
      `/api/v1/custom-blocks/${encodeURIComponent(blockId)}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, baseRevision }),
      },
      customBlockRecordSchema,
    );
  }

  async remove(blockId: string, operationId: string, baseRevision: number): Promise<void> {
    await this.request(
      `/api/v1/custom-blocks/${encodeURIComponent(blockId)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, baseRevision }),
      },
      {
        parse: (value: unknown) => {
          if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) {
            throw new CustomBlockApiError(502, "SERVICE_UNAVAILABLE");
          }
          return undefined;
        },
      },
    );
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
    } catch (cause) {
      throw new CustomBlockApiError(0, cause instanceof Error ? cause.message : "NETWORK_ERROR");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const envelope = apiErrorEnvelopeSchema.safeParse(payload);
      throw new CustomBlockApiError(
        response.status,
        envelope.success ? envelope.data.error.code : `HTTP_${response.status}`,
      );
    }
    return schema.parse(payload);
  }
}
