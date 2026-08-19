import { hc } from "hono/client";
import type { AppType } from "@glyphquire/api/app";

export type { AppType };

export function createApiClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
}

export type ApiClient = ReturnType<typeof createApiClient>;
