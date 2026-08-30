import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssetResponse,
  ExportResult,
  ImportJobResult,
  SearchResponse,
  ShareLinkResponse,
} from "@glyphquire/api-contract";
import { Phase5ApiError } from "../api/Phase5Client.js";
import { PHASE5_PENDING_STORAGE_KEY, usePhase5Store } from "./phase5.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const IMPORT_ID = "44444444-4444-4444-8444-444444444444";
const EXPORT_ID = "55555555-5555-4555-8555-555555555555";
const SHARE_ID = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-08-30T00:00:00.000Z";

function progress() {
  return { completedItems: 0, totalItems: 1, processedBytes: 0, totalBytes: 12 };
}

function pendingImport(status: ImportJobResult["status"] = "pending"): ImportJobResult {
  return { id: IMPORT_ID, workspaceId: WORKSPACE_ID, status, progress: progress() };
}

function pendingExport(status: ExportResult["status"] = "pending"): ExportResult {
  return {
    id: EXPORT_ID,
    workspaceId: WORKSPACE_ID,
    status,
    format: "zip",
    scope: { type: "workspace", workspaceId: WORKSPACE_ID },
    createdAt: NOW,
    expiresAt: "2026-09-29T00:00:00.000Z",
  };
}

function fakeClient() {
  return {
    uploadAsset: vi.fn<() => Promise<AssetResponse>>(),
    search: vi.fn<() => Promise<SearchResponse>>(),
    startImport: vi.fn(async () => pendingImport()),
    getImport: vi.fn(async () => pendingImport("completed")),
    startExport: vi.fn(async () => pendingExport()),
    getExport: vi.fn(async () => pendingExport("completed")),
    createShareLink: vi.fn<() => Promise<ShareLinkResponse>>(),
    revokeShareLink: vi.fn(async () => undefined),
  };
}

describe("Phase 5 transfer and permission store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useRealTimers();
  });

  it("persists only bounded transfer identifiers and resumes pending polling after reload", async () => {
    const firstClient = fakeClient();
    const first = usePhase5Store();
    first.configure(firstClient, { pollIntervalMs: 1_000, maxPollAttempts: 3 });

    await first.startImport({
      workspaceId: WORKSPACE_ID,
      file: new File(["TOP SECRET MARKDOWN"], "private.md", { type: "text/markdown" }),
    });
    await first.startExport({
      scope: { type: "workspace", workspaceId: WORKSPACE_ID },
      format: "zip",
    });

    const serialized = localStorage.getItem(PHASE5_PENDING_STORAGE_KEY);
    expect(serialized).toContain(IMPORT_ID);
    expect(serialized).toContain(EXPORT_ID);
    expect(serialized).toContain(WORKSPACE_ID);
    expect(serialized).not.toContain("TOP SECRET MARKDOWN");
    expect(serialized).not.toContain("private.md");
    expect(serialized).not.toMatch(/token|downloadUrl|markdown/iu);

    first.stopPolling();
    setActivePinia(createPinia());
    const resumedClient = fakeClient();
    const resumed = usePhase5Store();
    resumed.configure(resumedClient, { pollIntervalMs: 1_000, maxPollAttempts: 3 });
    await resumed.resumePending();

    expect(resumedClient.getImport).toHaveBeenCalledWith(IMPORT_ID);
    expect(resumedClient.getExport).toHaveBeenCalledWith(EXPORT_ID);
    expect(resumed.imports[IMPORT_ID]?.status).toBe("completed");
    expect(resumed.exports[EXPORT_ID]?.status).toBe("completed");
    expect(localStorage.getItem(PHASE5_PENDING_STORAGE_KEY)).toBeNull();
  });

  it("bounds repeated status polling and exposes an explicit paused state", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    client.getImport.mockResolvedValue(pendingImport("processing"));
    const store = usePhase5Store();
    store.configure(client, { pollIntervalMs: 100, maxPollAttempts: 2 });
    localStorage.setItem(
      PHASE5_PENDING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        transfers: [{ kind: "import", id: IMPORT_ID, workspaceId: WORKSPACE_ID, attempts: 0 }],
      }),
    );

    await store.resumePending();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(client.getImport).toHaveBeenCalledTimes(2);
    expect(store.pollingPaused).toBe(true);
    expect(store.error).toBe("Transfer status checks paused. Retry to continue.");
    expect(vi.getTimerCount()).toBe(0);
    store.stopPolling();
  });

  it("drops malformed persisted state without sending attacker-controlled identifiers", async () => {
    const client = fakeClient();
    const store = usePhase5Store();
    store.configure(client);
    localStorage.setItem(
      PHASE5_PENDING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        transfers: [
          {
            kind: "import",
            id: "../../private",
            workspaceId: WORKSPACE_ID,
            attempts: 0,
            token: "SECRET",
          },
        ],
      }),
    );

    await store.resumePending();

    expect(client.getImport).not.toHaveBeenCalled();
    expect(localStorage.getItem(PHASE5_PENDING_STORAGE_KEY)).toBeNull();
  });

  it("renders one sanitized permission state without provider or document detail", async () => {
    const client = fakeClient();
    client.search.mockRejectedValue(
      Object.assign(
        new Phase5ApiError("NOTE_NOT_FOUND", 404, "77777777-7777-4777-8777-777777777777"),
        { providerDetail: "postgres://secret markdown=# hidden" },
      ),
    );
    const store = usePhase5Store();
    store.configure(client);

    await expect(
      store.searchWorkspace({ workspaceId: WORKSPACE_ID, q: "needle", pageSize: 20 }),
    ).rejects.toBeInstanceOf(Phase5ApiError);

    expect(store.permissionDenied).toBe(true);
    expect(store.error).toBe("You do not have permission, or the item is unavailable.");
    expect(JSON.stringify({ error: store.error })).not.toMatch(/postgres|secret|hidden/iu);
  });

  it("removes a revoked share token from all UI state and never persists it", async () => {
    const token = "A".repeat(43);
    const client = fakeClient();
    client.createShareLink.mockResolvedValue({
      id: SHARE_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      token,
      url: `${location.origin}/api/v1/shared/${token}`,
      expiresAt: null,
      createdAt: NOW,
    });
    const store = usePhase5Store();
    store.configure(client);

    await store.createShareLink(NOTE_ID, {});
    expect(store.shareLinks).toHaveLength(1);
    await store.revokeShareLink(SHARE_ID);

    expect(store.shareLinks).toEqual([]);
    expect(JSON.stringify(localStorage)).not.toContain(token);
  });
});
