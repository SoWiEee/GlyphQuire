import { randomUUID } from "node:crypto";
import type {
  CreateCustomBlockInput,
  CustomBlockListResult,
  CustomBlockRecord,
  PublishCustomBlockInput,
  UpdateCustomBlockDraftInput,
} from "@glyphquire/api-contract";
import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { createErrorHandler, PublicApiError } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { CustomBlockService } from "../../modules/custom-blocks/CustomBlockService.js";
import { createCustomBlockRoutes } from "./custom-blocks.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const blockId = "00000000-0000-4000-8000-000000000002";
const record = {
  id: blockId,
  workspaceId,
  name: "reading-score",
  revision: 1,
  version: 1,
  status: "draft" as const,
  definition: {
    name: "reading-score",
    version: 1,
    kind: "container" as const,
    propsSchema: { label: { type: "string" as const, required: true, maxLength: 50 } },
    contentPolicy: "optional" as const,
    icon: "check" as const,
    preset: "rating" as const,
    capabilities: ["static" as const],
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  publishedAt: null,
} satisfies CustomBlockRecord;

class FakeService implements CustomBlockService {
  calls: string[] = [];
  async list(): Promise<CustomBlockListResult> {
    this.calls.push("list");
    return { items: [record] };
  }
  async create(_actorId: string, _workspaceId: string, _input: CreateCustomBlockInput) {
    this.calls.push("create");
    return record;
  }
  async updateDraft(_actorId: string, _blockId: string, _input: UpdateCustomBlockDraftInput) {
    this.calls.push("update");
    return record;
  }
  async publish(_actorId: string, _blockId: string, _input: PublishCustomBlockInput) {
    this.calls.push("publish");
    return { ...record, status: "published" as const, publishedAt: record.updatedAt };
  }
  async removeDraft() {
    this.calls.push("delete");
  }
}

function appFor(service: CustomBlockService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", async (context: Context<{ Variables: SecurityVariables }>, next) => {
      if (!context.req.header("x-actor")) throw new PublicApiError("NOTE_NOT_FOUND", 404);
      context.set("requestId", randomUUID());
      context.set("clientIp", "127.0.0.1");
      context.set("requestContext", {
        requestId: context.get("requestId"),
        actorId: context.req.header("x-actor")!,
        session: {} as never,
      });
      await next();
    })
    .onError(createErrorHandler({ error() {} }))
    .route("/api/v1", createCustomBlockRoutes(service));
}

describe("Custom Block routes", () => {
  it("uses the authenticated actor for list and rejects malformed workspace ids", async () => {
    const service = new FakeService();
    const app = appFor(service);
    const response = await app.request(`/api/v1/workspaces/${workspaceId}/custom-blocks`, {
      headers: { "x-actor": "actor-1" },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
    expect(service.calls).toEqual(["list"]);

    const malformed = await app.request("/api/v1/workspaces/not-a-uuid/custom-blocks", {
      headers: { "x-actor": "actor-1" },
    });
    expect(malformed.status).toBe(400);
  });

  it("protects mutation routes behind auth and strict request contracts", async () => {
    const service = new FakeService();
    const app = appFor(service);
    const unauthorized = await app.request(`/api/v1/workspaces/${workspaceId}/custom-blocks`, {
      method: "POST",
      body: "{}",
    });
    expect(unauthorized.status).toBe(404);

    const invalid = await app.request(`/api/v1/workspaces/${workspaceId}/custom-blocks`, {
      method: "POST",
      headers: { "x-actor": "actor-1", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "op",
        definition: { ...record.definition, html: "<script>" },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(service.calls).toEqual([]);
  });
});
