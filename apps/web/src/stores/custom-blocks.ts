import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { CustomBlockRecord } from "@glyphquire/api-contract";
import type { CustomBlockDefinition } from "@glyphquire/theme-sdk";
import { CustomBlockClient } from "../api/CustomBlockClient.js";
import { newOperationId } from "../lib/operationId.js";

type CustomBlockClientPort = Pick<
  CustomBlockClient,
  "list" | "create" | "updateDraft" | "publish" | "remove"
>;

export const useCustomBlocksStore = defineStore("custom-blocks", () => {
  const client = shallowRef<CustomBlockClientPort>(new CustomBlockClient());
  const definitions = ref<CustomBlockRecord[]>([]);
  const workspaceId = ref<string | null>(null);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);
  let operationIdFactory = newOperationId;
  let loadGeneration = 0;

  function configure(
    nextClient: CustomBlockClientPort,
    options: { operationIdFactory?: () => string } = {},
  ): void {
    client.value = nextClient;
    operationIdFactory = options.operationIdFactory ?? newOperationId;
  }

  async function load(nextWorkspaceId: string): Promise<void> {
    const generation = ++loadGeneration;
    workspaceId.value = nextWorkspaceId;
    loading.value = true;
    error.value = null;
    try {
      const nextDefinitions = await client.value.list(nextWorkspaceId);
      if (generation === loadGeneration && workspaceId.value === nextWorkspaceId) {
        definitions.value = nextDefinitions;
      }
    } catch (cause) {
      definitions.value = [];
      error.value = cause instanceof Error ? cause.message : "Custom Blocks are unavailable.";
      throw cause;
    } finally {
      loading.value = false;
    }
  }

  function requireWorkspace(): string {
    if (!workspaceId.value) throw new Error("Select a workspace before managing Custom Blocks");
    return workspaceId.value;
  }

  function replace(record: CustomBlockRecord): void {
    const index = definitions.value.findIndex((item) => item.id === record.id);
    if (index === -1) definitions.value = [...definitions.value, record];
    else
      definitions.value = definitions.value.map((item, itemIndex) =>
        itemIndex === index ? record : item,
      );
  }

  async function create(definition: CustomBlockDefinition): Promise<CustomBlockRecord> {
    const record = await client.value.create(requireWorkspace(), operationIdFactory(), definition);
    replace(record);
    return record;
  }

  async function updateDraft(
    blockId: string,
    definition: CustomBlockDefinition,
  ): Promise<CustomBlockRecord> {
    const current = definitions.value.find((item) => item.id === blockId);
    if (!current) throw new Error("Custom Block is no longer available");
    const record = await client.value.updateDraft(
      blockId,
      operationIdFactory(),
      current.revision,
      definition,
    );
    replace(record);
    return record;
  }

  async function publish(blockId: string): Promise<CustomBlockRecord> {
    const current = definitions.value.find((item) => item.id === blockId);
    if (!current) throw new Error("Custom Block is no longer available");
    const record = await client.value.publish(blockId, operationIdFactory(), current.revision);
    replace(record);
    return record;
  }

  async function remove(blockId: string): Promise<void> {
    await client.value.remove(blockId);
    definitions.value = definitions.value.filter((item) => item.id !== blockId);
  }

  return {
    definitions,
    workspaceId,
    loading,
    busy,
    error,
    configure,
    load,
    create,
    updateDraft,
    publish,
    remove,
  };
});
