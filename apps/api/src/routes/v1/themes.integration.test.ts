import { describe, expect, it } from "vitest";
import { createApp } from "../../app.js";

const TEST_ENV = {
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? "postgres://gq_app:gq_app_dev@localhost:5432/glyphquire_dev",
  BETTER_AUTH_URL: "http://localhost:3001",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  TRUSTED_PROXY_CIDRS: "",
  FORWARDED_IP_HEADER: "x-forwarded-for",
};

describe("Theme API routes", () => {
  const app = createApp(TEST_ENV);

  it("GET /api/v1/workspaces/:id/themes returns uniform 404 without auth", async () => {
    const res = await app.request("/api/v1/workspaces/00000000-0000-4000-8000-000000000001/themes");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/v1/themes/:id rejects missing Origin before auth", async () => {
    const res = await app.request("/api/v1/themes/00000000-0000-4000-8000-000000000001", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
