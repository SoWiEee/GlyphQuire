import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type {
  BackupVerificationResponse,
  DeadLetterResponse,
  MaintenanceCapabilitiesResponse,
  MaintenanceJobMutationResponse,
} from "@glyphquire/api-contract";
import { Phase5ApiError, type Phase5MaintenanceClient } from "../../api/Phase5Client.js";
import Phase5MaintenancePanel from "./Phase5MaintenancePanel.vue";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const DEAD_LETTER_ID = "33333333-3333-4333-8333-333333333333";
const BACKUP_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

function capabilities(
  overrides: Partial<MaintenanceCapabilitiesResponse> = {},
): MaintenanceCapabilitiesResponse {
  return {
    operator: true,
    capabilities: ["search.rebuild", "jobs.dead_letters", "asset.cleanup", "backup.verify"],
    ...overrides,
  };
}

function mutation(overrides: Partial<MaintenanceJobMutationResponse> = {}) {
  return { jobId: JOB_ID, duplicate: false, ...overrides };
}

function deadLetters(overrides: Partial<DeadLetterResponse> = {}): DeadLetterResponse {
  return {
    items: [
      {
        id: DEAD_LETTER_ID,
        workspaceId: WORKSPACE_ID,
        type: "export",
        attempts: 3,
        maxAttempts: 5,
        createdAt: "2026-08-30T00:00:00.000Z",
        deadLetteredAt: "2026-08-30T00:01:00.000Z",
        errorCode: "JOB_FAILED",
      },
    ],
    nextCursor: null,
    ...overrides,
  };
}

function backups(overrides: Partial<BackupVerificationResponse> = {}): BackupVerificationResponse {
  return {
    items: [
      {
        jobId: JOB_ID,
        backupId: BACKUP_ID,
        status: "processing",
        createdAt: "2026-08-30T00:00:00.000Z",
        completedAt: null,
        errorCode: null,
      },
    ],
    nextCursor: null,
    ...overrides,
  };
}

function client(overrides: Partial<Phase5MaintenanceClient> = {}): Phase5MaintenanceClient {
  return {
    getMaintenanceCapabilities: vi.fn(async () => capabilities()),
    startSearchRebuild: vi.fn(async () => mutation()),
    listDeadLetters: vi.fn(async () => deadLetters()),
    replayDeadLetter: vi.fn(async () => mutation()),
    runAssetCleanup: vi.fn(async () => mutation()),
    getBackupVerification: vi.fn(async () => backups()),
    ...overrides,
  };
}

describe("Phase5MaintenancePanel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders no maintenance controls for a normal member and scrubs the denial", async () => {
    const detail = "postgres://private markdown=# hidden token=TOP_SECRET";
    const api = client({
      getMaintenanceCapabilities: vi.fn(async () => {
        const error = Object.assign(new Phase5ApiError("NOTE_NOT_FOUND", 404, REQUEST_ID), {
          detail,
        });
        throw error;
      }),
    });
    const wrapper = mount(Phase5MaintenancePanel, {
      props: { workspaceId: WORKSPACE_ID, client: api },
    });
    await flushPromises();

    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').text()).toBe("Maintenance controls are unavailable.");
    expect(wrapper.html()).not.toContain(detail);
    expect(wrapper.html()).not.toMatch(/TOP_SECRET|postgres|markdown/iu);
    wrapper.unmount();
  });

  it("treats an explicit non-operator capability response like a denied envelope", async () => {
    const api = client({
      getMaintenanceCapabilities: vi.fn(async () =>
        capabilities({ operator: false, capabilities: [] }),
      ),
    });
    const wrapper = mount(Phase5MaintenancePanel, {
      props: { workspaceId: WORKSPACE_ID, client: api },
    });
    await flushPromises();

    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toBe("Maintenance controls are unavailable.");
    wrapper.unmount();
  });

  it("shows only the server-authorized controls and sends bounded workspace jobs", async () => {
    const api = client({
      getMaintenanceCapabilities: vi.fn(async () =>
        capabilities({ capabilities: ["search.rebuild", "asset.cleanup"] }),
      ),
    });
    const wrapper = mount(Phase5MaintenancePanel, {
      props: { workspaceId: WORKSPACE_ID, client: api },
    });
    await flushPromises();

    expect(wrapper.get('button[aria-label="Start search rebuild"]').exists()).toBe(true);
    expect(wrapper.get('button[aria-label="Run asset cleanup"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Dead-letter jobs"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Backup verification"]').exists()).toBe(false);

    await wrapper.get('input[aria-label="Search rebuild batch size"]').setValue("100");
    await wrapper.get('button[aria-label="Start search rebuild"]').trigger("click");
    await flushPromises();
    expect(api.startSearchRebuild).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      batchSize: 100,
    });

    await wrapper.get('input[aria-label="Asset cleanup batch size"]').setValue("101");
    await wrapper.get('button[aria-label="Run asset cleanup"]').trigger("click");
    await flushPromises();
    expect(api.runAssetCleanup).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toBe("Choose a batch size from 1 to 100.");
    wrapper.unmount();
  });

  it("renders scrubbed diagnostics, replays by opaque id, and keeps pagination cursor bounded", async () => {
    const api = client();
    const wrapper = mount(Phase5MaintenancePanel, {
      props: { workspaceId: WORKSPACE_ID, client: api },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Refresh maintenance diagnostics"]').trigger("click");
    await flushPromises();
    expect(api.listDeadLetters).toHaveBeenCalledWith({ pageSize: 100 });
    expect(api.getBackupVerification).toHaveBeenCalledWith({ pageSize: 100 });
    expect(wrapper.text()).toContain("export");
    expect(wrapper.text()).toContain("JOB_FAILED");
    expect(wrapper.text()).not.toMatch(/payload|objectKey|token|markdown/iu);

    await wrapper.get('button[aria-label="Replay dead-letter job"]').trigger("click");
    await flushPromises();
    expect(api.replayDeadLetter).toHaveBeenCalledWith(DEAD_LETTER_ID);
    wrapper.unmount();
  });

  it("polls diagnostics only within the configured attempt bound", async () => {
    const api = client();
    const wrapper = mount(Phase5MaintenancePanel, {
      props: { workspaceId: WORKSPACE_ID, client: api, pollIntervalMs: 10, maxPollAttempts: 2 },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Start search rebuild"]').trigger("click");
    await flushPromises();
    expect(api.listDeadLetters).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(50);
    await flushPromises();

    expect(api.listDeadLetters).toHaveBeenCalledTimes(2);
    expect(api.getBackupVerification).toHaveBeenCalledTimes(2);
    expect(wrapper.html()).not.toMatch(/TOP_SECRET|private|markdown/iu);
    wrapper.unmount();
  });
});
