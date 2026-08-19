import { hc } from "hono/client";
import type { Hono } from "hono";

// AppType will be imported from apps/api once it exists.
// For now, export the client factory pattern.
// After apps/api is built (Task 5), update this file to:
//   import type { AppType } from "../../../apps/api/src/app.js";
//   export type { AppType };
//   export function createApiClient(baseUrl: string) {
//     return hc<AppType>(baseUrl);
//   }

export type ApiClient = ReturnType<typeof hc>;

export function createApiClient<T extends Hono<any, any, any>>(
  baseUrl: string,
): ReturnType<typeof hc<T>> {
  return hc<T>(baseUrl);
}
