import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomBlockRecord } from "@glyphquire/api-contract";
import { CustomBlockClient } from "../../api/CustomBlockClient.js";
import { useCustomBlocksStore } from "../../stores/custom-blocks.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const BLOCK_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";

const definition = {
  name: "reading-score",
  version: 1,
  kind: "container" as const,
  propsSchema: {
    label: { type: "string" as const, required: true, maxLength: 50 },
  },
  contentPolicy: "optional" as const,
  icon: "check" as const,
  preset: "rating" as const,
  capabilities: ["static" as const],
};

const record: CustomBlockRecord = {
  id: BLOCK_ID,
  workspaceId: WORKSPACE_ID,
  name: definition.name,
  revision: 1,
  version: definition.version,
  status: "draft",
  definition,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  publishedAt: null,
};

describe("Custom Block workspace store", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("loads only the requested workspace and publishes with a CAS revision", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        expect(url).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/custom-blocks`);
        expect(init.credentials).toBe("include");
        return new Response(JSON.stringify({ items: [record] }), { status: 200 });
      }
      expect(url).toBe(`/api/v1/custom-blocks/${BLOCK_ID}/publish`);
      expect(init?.credentials).toBe("include");
      expect(JSON.parse(String(init?.body))).toEqual({
        operationId: OPERATION_ID,
        baseRevision: 1,
      });
      return new Response(
        JSON.stringify({ ...record, status: "published", publishedAt: record.updatedAt }),
        { status: 200 },
      );
    });

    const client = new CustomBlockClient({
      fetchImpl,
    });
    const store = useCustomBlocksStore();
    store.configure(client, { operationIdFactory: () => OPERATION_ID });

    await store.load(WORKSPACE_ID);
    expect(store.definitions).toEqual([record]);

    await store.publish(BLOCK_ID);
    expect(store.definitions[0]?.status).toBe("published");
    expect(store.definitions[0]?.workspaceId).toBe(WORKSPACE_ID);
  });
});
