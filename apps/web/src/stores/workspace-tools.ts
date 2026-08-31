import { computed, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import {
  canonicalUuidSchema,
  exportResultSchema,
  importJobResultSchema,
  type AssetResponse,
  type CreateShareLinkInput,
  type ExportResult,
  type ImportJobResult,
  type SearchQuery,
  type SearchResult,
  type ShareLinkResponse,
} from "@glyphquire/api-contract";
import { z } from "zod";
import {
  WorkspaceToolsApiError,
  WorkspaceToolsOfflineError,
  WorkspaceToolsValidationError,
  WorkspaceToolsClient,
  type StartExportInput,
  type StartImportInput,
  type UploadAssetInput,
} from "../api/WorkspaceToolsClient.js";

export const WORKSPACE_TOOLS_PENDING_STORAGE_KEY = "glyphquire.workspace-tools.pending.v1";
const MAX_PERSISTED_BYTES = 64 * 1024;
const MAX_PENDING_TRANSFERS = 20;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 120;

const pendingTransferSchema = z
  .object({
    kind: z.enum(["import", "export"]),
    id: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema,
    attempts: z.number().int().nonnegative().max(DEFAULT_MAX_POLL_ATTEMPTS),
  })
  .strict();

const persistedPendingSchema = z
  .object({
    version: z.literal(1),
    transfers: z.array(pendingTransferSchema).max(MAX_PENDING_TRANSFERS),
  })
  .strict();

type PendingTransfer = z.infer<typeof pendingTransferSchema>;
export type WorkspacePermissionState = "unknown" | "allowed" | "denied";
export type WorkspaceOperatorState = "unknown" | "member" | "operator";

export interface WorkspaceToolsClientPort {
  uploadAsset(input: UploadAssetInput): Promise<AssetResponse>;
  search(input: SearchQuery): Promise<{ items: SearchResult[]; nextCursor: string | null }>;
  startImport(input: StartImportInput): Promise<ImportJobResult>;
  getImport(importId: string): Promise<ImportJobResult>;
  startExport(input: StartExportInput): Promise<ExportResult>;
  getExport(exportId: string, options?: { download?: boolean }): Promise<ExportResult>;
  createShareLink(
    noteId: string,
    input: CreateShareLinkInput,
    idempotencyKey?: string,
  ): Promise<ShareLinkResponse>;
  revokeShareLink(linkId: string): Promise<void>;
}

export interface WorkspaceToolsStoreOptions {
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

function terminalImport(status: ImportJobResult["status"]): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

function terminalExport(status: ExportResult["status"]): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

function publicError(error: unknown): { message: string; denied: boolean } {
  if (error instanceof WorkspaceToolsApiError) {
    if (error.code === "NOTE_NOT_FOUND" || error.code === "SHARE_NOT_FOUND") {
      return {
        message: "You do not have permission, or the item is unavailable.",
        denied: true,
      };
    }
    switch (error.code) {
      case "ASSET_INVALID":
        return { message: "The asset request was rejected.", denied: false };
      case "SEARCH_UNAVAILABLE":
        return { message: "Search is temporarily unavailable.", denied: false };
      case "IMPORT_INVALID":
        return { message: "The import failed or expired.", denied: false };
      case "EXPORT_FAILED":
        return { message: "The export failed or expired.", denied: false };
      case "RATE_LIMITED":
        return { message: "Too many requests. Try again later.", denied: false };
      default:
        return { message: "The service is temporarily unavailable.", denied: false };
    }
  }
  if (
    error instanceof WorkspaceToolsOfflineError ||
    error instanceof WorkspaceToolsValidationError ||
    error instanceof Error
  ) {
    return { message: "The service is temporarily unavailable.", denied: false };
  }
  return { message: "The service is temporarily unavailable.", denied: false };
}

function defaultStorage(): WorkspaceToolsStoreOptions["storage"] {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export const useWorkspaceToolsStore = defineStore("workspace-tools", () => {
  const client = shallowRef<WorkspaceToolsClientPort>(new WorkspaceToolsClient());
  const assets = ref<AssetResponse[]>([]);
  const searchResults = ref<SearchResult[]>([]);
  const imports = ref<Record<string, ImportJobResult>>({});
  const exports = ref<Record<string, ExportResult>>({});
  const shareLinks = ref<ShareLinkResponse[]>([]);
  const pending = ref<PendingTransfer[]>([]);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const permissionState = ref<WorkspacePermissionState>("unknown");
  const operatorState = ref<WorkspaceOperatorState>("unknown");
  const pollingPaused = ref(false);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS;
  let storage = defaultStorage();

  const permissionDenied = computed(() => permissionState.value === "denied");

  function configure(
    nextClient: WorkspaceToolsClientPort,
    options: WorkspaceToolsStoreOptions = {},
  ): void {
    client.value = nextClient;
    const nextInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const nextMaximum = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
    if (!Number.isInteger(nextInterval) || nextInterval < 10 || nextInterval > 60_000) {
      throw new Error("Invalid workspace tools polling interval");
    }
    if (!Number.isInteger(nextMaximum) || nextMaximum < 1 || nextMaximum > 120) {
      throw new Error("Invalid workspace tools polling bound");
    }
    pollIntervalMs = nextInterval;
    maxPollAttempts = nextMaximum;
    storage = options.storage ?? defaultStorage();
  }

  function setOperatorState(next: WorkspaceOperatorState): void {
    if (next !== "unknown" && next !== "member" && next !== "operator") return;
    operatorState.value = next;
  }

  function clearError(): void {
    error.value = null;
    permissionState.value = "unknown";
  }

  function capture(errorValue: unknown): void {
    const projection = publicError(errorValue);
    error.value = projection.message;
    permissionState.value = projection.denied ? "denied" : "unknown";
  }

  async function operation<T>(run: () => Promise<T>): Promise<T> {
    busy.value = true;
    clearError();
    try {
      const result = await run();
      permissionState.value = "allowed";
      return result;
    } catch (cause) {
      capture(cause);
      throw cause;
    } finally {
      busy.value = false;
    }
  }

  function timerKey(transfer: PendingTransfer): string {
    return `${transfer.kind}:${transfer.id}`;
  }

  function persistPending(): void {
    if (!storage) return;
    if (pending.value.length === 0) {
      storage.removeItem(WORKSPACE_TOOLS_PENDING_STORAGE_KEY);
      return;
    }
    const bounded = persistedPendingSchema.parse({ version: 1, transfers: pending.value });
    storage.setItem(WORKSPACE_TOOLS_PENDING_STORAGE_KEY, JSON.stringify(bounded));
  }

  function upsertPending(transfer: PendingTransfer): void {
    const without = pending.value.filter(
      (entry) => entry.kind !== transfer.kind || entry.id !== transfer.id,
    );
    pending.value = [...without, transfer].slice(-MAX_PENDING_TRANSFERS);
    persistPending();
  }

  function removePending(transfer: PendingTransfer): void {
    const key = timerKey(transfer);
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(key);
    pending.value = pending.value.filter(
      (entry) => entry.kind !== transfer.kind || entry.id !== transfer.id,
    );
    persistPending();
  }

  function pausePolling(): void {
    pollingPaused.value = true;
    error.value = "Transfer status checks paused. Retry to continue.";
  }

  function schedule(transfer: PendingTransfer): void {
    const key = timerKey(transfer);
    if (timers.has(key)) return;
    if (transfer.attempts >= maxPollAttempts) {
      pausePolling();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(key);
      void pollOne(transfer).catch(() => undefined);
    }, pollIntervalMs);
    timers.set(key, timer);
  }

  async function pollOne(current: PendingTransfer): Promise<void> {
    const live = pending.value.find(
      (entry) => entry.kind === current.kind && entry.id === current.id,
    );
    if (!live) return;
    if (live.attempts >= maxPollAttempts) {
      pausePolling();
      return;
    }
    const attempted = { ...live, attempts: live.attempts + 1 };
    upsertPending(attempted);
    try {
      if (attempted.kind === "import") {
        const result = importJobResultSchema.parse(await client.value.getImport(attempted.id));
        if (result.workspaceId !== attempted.workspaceId)
          throw new WorkspaceToolsValidationError("response");
        imports.value = { ...imports.value, [result.id]: result };
        if (terminalImport(result.status)) removePending(attempted);
        else schedule(attempted);
      } else {
        const result = exportResultSchema.parse(await client.value.getExport(attempted.id));
        if (result.workspaceId !== attempted.workspaceId)
          throw new WorkspaceToolsValidationError("response");
        exports.value = { ...exports.value, [result.id]: result };
        if (terminalExport(result.status)) removePending(attempted);
        else schedule(attempted);
      }
    } catch (cause) {
      capture(cause);
      if (attempted.attempts >= maxPollAttempts) pausePolling();
      else schedule(attempted);
    }
  }

  function loadPending(): PendingTransfer[] {
    if (!storage) return [];
    const serialized = storage.getItem(WORKSPACE_TOOLS_PENDING_STORAGE_KEY);
    if (!serialized) return [];
    if (new TextEncoder().encode(serialized).byteLength > MAX_PERSISTED_BYTES) {
      storage.removeItem(WORKSPACE_TOOLS_PENDING_STORAGE_KEY);
      return [];
    }
    try {
      const parsed = persistedPendingSchema.safeParse(JSON.parse(serialized));
      if (!parsed.success) throw new Error("invalid pending state");
      const unique = new Set<string>();
      for (const transfer of parsed.data.transfers) {
        const key = timerKey(transfer);
        if (unique.has(key)) throw new Error("duplicate pending state");
        unique.add(key);
      }
      return parsed.data.transfers;
    } catch {
      storage.removeItem(WORKSPACE_TOOLS_PENDING_STORAGE_KEY);
      return [];
    }
  }

  async function resumePending(): Promise<void> {
    pollingPaused.value = false;
    pending.value = loadPending();
    await Promise.all(pending.value.map((transfer) => pollOne(transfer)));
  }

  async function retryPolling(): Promise<void> {
    pollingPaused.value = false;
    clearError();
    pending.value = pending.value.map((transfer) => ({ ...transfer, attempts: 0 }));
    persistPending();
    await Promise.all(pending.value.map((transfer) => pollOne(transfer)));
  }

  function stopPolling(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  async function uploadAsset(input: UploadAssetInput): Promise<AssetResponse> {
    return operation(async () => {
      const result = await client.value.uploadAsset(input);
      assets.value = [...assets.value.filter((asset) => asset.id !== result.id), result];
      return result;
    });
  }

  async function searchWorkspace(input: SearchQuery): Promise<SearchResult[]> {
    return operation(async () => {
      const result = await client.value.search(input);
      searchResults.value = result.items;
      return result.items;
    });
  }

  async function startImport(input: StartImportInput): Promise<ImportJobResult> {
    return operation(async () => {
      const result = await client.value.startImport(input);
      imports.value = { ...imports.value, [result.id]: result };
      if (!terminalImport(result.status)) {
        const transfer: PendingTransfer = {
          kind: "import",
          id: result.id,
          workspaceId: result.workspaceId,
          attempts: 0,
        };
        upsertPending(transfer);
        schedule(transfer);
      }
      return result;
    });
  }

  async function startExport(input: StartExportInput): Promise<ExportResult> {
    return operation(async () => {
      const result = await client.value.startExport(input);
      exports.value = { ...exports.value, [result.id]: result };
      if (!terminalExport(result.status)) {
        const transfer: PendingTransfer = {
          kind: "export",
          id: result.id,
          workspaceId: result.workspaceId,
          attempts: 0,
        };
        upsertPending(transfer);
        schedule(transfer);
      }
      return result;
    });
  }

  async function getExportDownload(exportId: string): Promise<ExportResult> {
    return operation(async () => {
      const result = await client.value.getExport(exportId, { download: true });
      exports.value = { ...exports.value, [result.id]: result };
      return result;
    });
  }

  async function createShareLink(
    noteId: string,
    input: CreateShareLinkInput,
  ): Promise<ShareLinkResponse> {
    return operation(async () => {
      const result = await client.value.createShareLink(noteId, input);
      shareLinks.value = [...shareLinks.value.filter((link) => link.id !== result.id), result];
      return result;
    });
  }

  async function revokeShareLink(linkId: string): Promise<void> {
    return operation(async () => {
      await client.value.revokeShareLink(linkId);
      shareLinks.value = shareLinks.value.filter((link) => link.id !== linkId);
    });
  }

  return {
    assets,
    searchResults,
    imports,
    exports,
    shareLinks,
    busy,
    error,
    permissionState,
    permissionDenied,
    operatorState,
    pollingPaused,
    configure,
    setOperatorState,
    clearError,
    resumePending,
    retryPolling,
    stopPolling,
    uploadAsset,
    searchWorkspace,
    startImport,
    startExport,
    getExportDownload,
    createShareLink,
    revokeShareLink,
  };
});
