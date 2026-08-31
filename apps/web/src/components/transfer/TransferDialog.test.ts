import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportResult, ImportJobResult } from "@glyphquire/api-contract";
import { WorkspaceToolsApiError } from "../../api/WorkspaceToolsClient.js";
import {
  useWorkspaceToolsStore,
  type WorkspaceToolsClientPort,
} from "../../stores/workspace-tools.js";
import TransferDialog from "./TransferDialog.vue";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const IMPORT_ID = "33333333-3333-4333-8333-333333333333";
const EXPORT_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-30T00:00:00.000Z";

function importResult(): ImportJobResult {
  return {
    id: IMPORT_ID,
    workspaceId: WORKSPACE_ID,
    status: "pending",
    progress: { completedItems: 0, totalItems: 1, processedBytes: 0, totalBytes: 12 },
  };
}

function exportResult(): ExportResult {
  return {
    id: EXPORT_ID,
    workspaceId: WORKSPACE_ID,
    status: "pending",
    format: "zip",
    scope: { type: "workspace", workspaceId: WORKSPACE_ID },
    createdAt: NOW,
    expiresAt: "2026-09-29T00:00:00.000Z",
  };
}

function client(overrides: Partial<WorkspaceToolsClientPort> = {}): WorkspaceToolsClientPort {
  return {
    uploadAsset: vi.fn(),
    search: vi.fn(),
    startImport: vi.fn(async () => importResult()),
    getImport: vi.fn(async () => importResult()),
    startExport: vi.fn(async () => exportResult()),
    getExport: vi.fn(async () => exportResult()),
    createShareLink: vi.fn(),
    revokeShareLink: vi.fn(),
    ...overrides,
  } as WorkspaceToolsClientPort;
}

describe("TransferDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("starts bounded import/export jobs and exposes only the supported formats", async () => {
    const api = client();
    const store = useWorkspaceToolsStore();
    store.configure(api, { pollIntervalMs: 60_000, maxPollAttempts: 2 });
    const wrapper = mount(TransferDialog, {
      props: { workspaceId: WORKSPACE_ID, noteId: NOTE_ID, baseRevision: 3 },
    });

    const format = wrapper.get('select[aria-label="Export format"]');
    expect(format.findAll("option").map((option) => option.attributes("value"))).toEqual([
      "markdown",
      "zip",
      "html",
    ]);
    await format.setValue("zip");
    await wrapper.get('button[aria-label="Export workspace"]').trigger("click");

    const input = wrapper.get<HTMLInputElement>('input[aria-label="Import Markdown or ZIP"]');
    const file = new File(["# private note"], "note.md", { type: "text/markdown" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await wrapper.get('button[aria-label="Start import"]').trigger("click");
    await flushPromises();

    expect(api.startExport).toHaveBeenCalledWith({
      scope: { type: "workspace", workspaceId: WORKSPACE_ID },
      format: "zip",
    });
    expect(api.startImport).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      file,
      noteId: NOTE_ID,
      baseRevision: 3,
    });
    expect(wrapper.text()).toContain("ZIP export queued");
    expect(wrapper.text()).toContain("Import queued");
    expect(localStorage.getItem("glyphquire.workspace-tools.pending.v1")).not.toContain(
      "private note",
    );
    store.stopPolling();
  });

  it("renders a stable import denial without raw provider details", async () => {
    const failure = Object.assign(
      new WorkspaceToolsApiError("IMPORT_INVALID", 400, "55555555-5555-4555-8555-555555555555"),
      { detail: "zip entry ../secret.md provider=minio token=SECRET" },
    );
    const api = client({ startImport: vi.fn(async () => Promise.reject(failure)) });
    const store = useWorkspaceToolsStore();
    store.configure(api);
    const wrapper = mount(TransferDialog, {
      props: { workspaceId: WORKSPACE_ID },
    });
    const input = wrapper.get<HTMLInputElement>('input[aria-label="Import Markdown or ZIP"]');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [new File(["bad"], "bad.zip", { type: "application/zip" })],
    });
    await input.trigger("change");
    await wrapper.get('button[aria-label="Start import"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe("The import failed or expired.");
    expect(wrapper.html()).not.toMatch(/secret\.md|minio|SECRET/u);
  });
});
