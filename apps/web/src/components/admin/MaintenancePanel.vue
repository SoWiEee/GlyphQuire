<template>
  <section
    aria-label="Administrative maintenance"
    class="space-y-4 rounded border border-gray-200 p-4"
  >
    <h2 class="text-sm font-semibold text-gray-900">Maintenance</h2>

    <p v-if="loadingCapabilities" class="text-sm text-gray-600">Checking maintenance access…</p>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p aria-live="polite" class="sr-only">{{ status }}</p>

    <template v-if="authorized && !loadingCapabilities">
      <section v-if="hasCapability('search.rebuild')" aria-label="Search rebuild" class="space-y-2">
        <h3 class="text-sm font-medium text-gray-900">Search index rebuild</h3>
        <label class="block text-sm text-gray-700">
          Batch size
          <input
            v-model="searchBatchSize"
            type="number"
            min="1"
            max="100"
            step="1"
            inputmode="numeric"
            aria-label="Search rebuild batch size"
            class="ml-2 w-20 rounded border border-gray-300 px-2 py-1"
          />
        </label>
        <button
          type="button"
          aria-label="Start search rebuild"
          :disabled="busy"
          class="rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          @click="startSearchRebuild"
        >
          Rebuild search index
        </button>
      </section>

      <section v-if="hasCapability('asset.cleanup')" aria-label="Asset cleanup" class="space-y-2">
        <h3 class="text-sm font-medium text-gray-900">Asset cleanup</h3>
        <label class="block text-sm text-gray-700">
          Batch size
          <input
            v-model="assetBatchSize"
            type="number"
            min="1"
            max="100"
            step="1"
            inputmode="numeric"
            aria-label="Asset cleanup batch size"
            class="ml-2 w-20 rounded border border-gray-300 px-2 py-1"
          />
        </label>
        <button
          type="button"
          aria-label="Run asset cleanup"
          :disabled="busy"
          class="rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          @click="runAssetCleanup"
        >
          Run asset cleanup
        </button>
      </section>

      <button
        v-if="hasDiagnostics"
        type="button"
        aria-label="Refresh maintenance diagnostics"
        :disabled="busy"
        class="rounded border border-gray-300 px-3 py-2 text-sm text-gray-800 disabled:opacity-50"
        @click="refreshDiagnostics"
      >
        Refresh diagnostics
      </button>

      <section
        v-if="hasCapability('jobs.dead_letters')"
        aria-label="Dead-letter jobs"
        class="space-y-2"
      >
        <h3 class="text-sm font-medium text-gray-900">Dead-letter jobs</h3>
        <p v-if="deadLetters.length === 0" class="text-sm text-gray-600">No dead-letter jobs.</p>
        <ul v-else class="space-y-2 text-sm">
          <li
            v-for="item in deadLetters"
            :key="item.id"
            class="flex items-center justify-between gap-3 rounded bg-gray-50 p-2"
          >
            <span class="text-sm">A maintenance task needs attention.</span>
            <button
              type="button"
              aria-label="Replay dead-letter job"
              :disabled="busy"
              class="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
              @click="replayDeadLetter(item.id)"
            >
              Replay
            </button>
          </li>
        </ul>
        <button
          v-if="deadLetterCursor"
          type="button"
          aria-label="Next dead-letter page"
          :disabled="busy"
          class="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
          @click="loadNextDeadLetters"
        >
          Next page
        </button>
      </section>

      <section
        v-if="hasCapability('backup.verify')"
        aria-label="Backup verification"
        class="space-y-2"
      >
        <h3 class="text-sm font-medium text-gray-900">Backup verification</h3>
        <p v-if="backupVerifications.length === 0" class="text-sm text-gray-600">
          No backup verification jobs.
        </p>
        <ul v-else class="space-y-2 text-sm">
          <li v-for="item in backupVerifications" :key="item.jobId" class="rounded bg-gray-50 p-2">
            <span class="block">{{ backupStatusLabel(item.status, item.errorCode) }}</span>
          </li>
        </ul>
        <button
          v-if="backupCursor"
          type="button"
          aria-label="Next backup verification page"
          :disabled="busy"
          class="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
          @click="loadNextBackups"
        >
          Next page
        </button>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  MAINTENANCE_CAPABILITIES,
  maintenanceBatchSizeSchema,
  type DeadLetterItem,
  type BackupVerificationItem,
} from "@glyphquire/api-contract";
import {
  WorkspaceToolsApiError,
  WorkspaceToolsClient,
  type MaintenanceClient,
} from "../../api/WorkspaceToolsClient.js";

type MaintenanceCapability = (typeof MAINTENANCE_CAPABILITIES)[number];

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 3;
const MAX_POLL_ATTEMPTS = 120;

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    client?: MaintenanceClient;
    pollIntervalMs?: number;
    maxPollAttempts?: number;
  }>(),
  { pollIntervalMs: 2_000, maxPollAttempts: 3 },
);

const api = props.client ?? new WorkspaceToolsClient();
const capabilities = ref<MaintenanceCapability[]>([]);
const loadingCapabilities = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const status = ref("");
const searchBatchSize = ref("100");
const assetBatchSize = ref("100");
const deadLetters = ref<DeadLetterItem[]>([]);
const backupVerifications = ref<BackupVerificationItem[]>([]);
const deadLetterCursor = ref<string | null>(null);
const backupCursor = ref<string | null>(null);
const pollAttempts = ref(0);
const pollIntervalMs = computed(() =>
  Number.isInteger(props.pollIntervalMs) &&
  props.pollIntervalMs >= MIN_POLL_INTERVAL_MS &&
  props.pollIntervalMs <= MAX_POLL_INTERVAL_MS
    ? props.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS,
);
const maxPollAttempts = computed(() =>
  Number.isInteger(props.maxPollAttempts) &&
  props.maxPollAttempts >= 1 &&
  props.maxPollAttempts <= MAX_POLL_ATTEMPTS
    ? props.maxPollAttempts
    : DEFAULT_MAX_POLL_ATTEMPTS,
);
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

const authorized = computed(() => !loadingCapabilities.value && capabilities.value.length > 0);
const hasDiagnostics = computed(
  () => hasCapability("jobs.dead_letters") || hasCapability("backup.verify"),
);

function hasCapability(capability: MaintenanceCapability): boolean {
  return authorized.value && capabilities.value.includes(capability);
}

function backupStatusLabel(
  statusValue: BackupVerificationItem["status"],
  errorCode: BackupVerificationItem["errorCode"],
): string {
  if (errorCode) return "Backup verification needs attention.";
  switch (statusValue) {
    case "pending":
      return "Backup verification is queued.";
    case "processing":
      return "Backup verification is in progress.";
    case "completed":
      return "Backup verification complete.";
    case "dead_letter":
      return "Backup verification needs attention.";
  }
}

function clearError(): void {
  error.value = null;
}

function reportFailure(): void {
  error.value = "Maintenance request failed.";
}

function reportDenied(): void {
  error.value = "Maintenance controls are unavailable.";
}

function handleFailure(cause: unknown): void {
  if (cause instanceof WorkspaceToolsApiError && cause.code === "NOTE_NOT_FOUND") {
    capabilities.value = [];
    reportDenied();
    return;
  }
  reportFailure();
}

function parseBatchSize(value: string): number | null {
  const parsed = maintenanceBatchSizeSchema.safeParse(Number(value));
  return parsed.success ? parsed.data : null;
}

function requireBatchSize(value: string): number | null {
  const parsed = parseBatchSize(value);
  if (parsed === null) error.value = "Choose a batch size from 1 to 100.";
  return parsed;
}

async function startSearchRebuild(): Promise<void> {
  const batchSize = requireBatchSize(searchBatchSize.value);
  if (batchSize === null) return;
  clearError();
  busy.value = true;
  try {
    const result = await api.startSearchRebuild({ workspaceId: props.workspaceId, batchSize });
    status.value = result.duplicate
      ? "Search rebuild was already queued."
      : "Search rebuild queued.";
    beginPolling();
  } catch (cause: unknown) {
    handleFailure(cause);
  } finally {
    busy.value = false;
  }
}

async function runAssetCleanup(): Promise<void> {
  const batchSize = requireBatchSize(assetBatchSize.value);
  if (batchSize === null) return;
  clearError();
  busy.value = true;
  try {
    const result = await api.runAssetCleanup({ workspaceId: props.workspaceId, batchSize });
    status.value = result.duplicate ? "Asset cleanup was already queued." : "Asset cleanup queued.";
    beginPolling();
  } catch (cause: unknown) {
    handleFailure(cause);
  } finally {
    busy.value = false;
  }
}

async function refreshDeadLetters(append = false): Promise<void> {
  if (!hasCapability("jobs.dead_letters")) return;
  const cursor = append ? deadLetterCursor.value : null;
  const result = await api.listDeadLetters({
    pageSize: 100,
    ...(cursor === null ? {} : { cursor }),
  });
  deadLetters.value = append ? [...deadLetters.value, ...result.items] : result.items;
  deadLetterCursor.value = result.nextCursor;
}

async function refreshBackups(append = false): Promise<void> {
  if (!hasCapability("backup.verify")) return;
  const cursor = append ? backupCursor.value : null;
  const result = await api.getBackupVerification({
    pageSize: 100,
    ...(cursor === null ? {} : { cursor }),
  });
  backupVerifications.value = append
    ? [...backupVerifications.value, ...result.items]
    : result.items;
  backupCursor.value = result.nextCursor;
}

async function refreshDiagnostics(): Promise<void> {
  clearError();
  busy.value = true;
  deadLetterCursor.value = null;
  backupCursor.value = null;
  try {
    await Promise.all([refreshDeadLetters(), refreshBackups()]);
  } catch (cause: unknown) {
    handleFailure(cause);
  } finally {
    busy.value = false;
  }
}

async function loadNextDeadLetters(): Promise<void> {
  if (!deadLetterCursor.value) return;
  clearError();
  busy.value = true;
  try {
    await refreshDeadLetters(true);
  } catch (cause: unknown) {
    handleFailure(cause);
  } finally {
    busy.value = false;
  }
}

async function loadNextBackups(): Promise<void> {
  if (!backupCursor.value) return;
  clearError();
  busy.value = true;
  try {
    await refreshBackups(true);
  } catch (cause: unknown) {
    handleFailure(cause);
  } finally {
    busy.value = false;
  }
}

async function replayDeadLetter(deadLetterId: string): Promise<void> {
  clearError();
  busy.value = true;
  try {
    const result = await api.replayDeadLetter(deadLetterId);
    status.value = result.duplicate
      ? "Dead-letter replay was already queued."
      : "Dead-letter replay queued.";
    beginPolling();
  } catch (cause: unknown) {
    handleFailure(cause);
  } finally {
    busy.value = false;
  }
}

function stopPolling(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}

function beginPolling(): void {
  stopPolling();
  pollAttempts.value = 0;
  schedulePoll();
}

function schedulePoll(): void {
  if (disposed || pollAttempts.value >= maxPollAttempts.value || !hasDiagnostics.value) return;
  pollTimer = setTimeout(() => {
    if (disposed) return;
    pollTimer = undefined;
    pollAttempts.value += 1;
    void refreshDiagnostics().finally(() => schedulePoll());
  }, pollIntervalMs.value);
}

async function loadCapabilities(): Promise<void> {
  try {
    const result = await api.getMaintenanceCapabilities();
    if (!result.operator || result.capabilities.length === 0) {
      reportDenied();
      return;
    }
    capabilities.value = result.capabilities;
  } catch (cause: unknown) {
    handleFailure(cause);
  } finally {
    loadingCapabilities.value = false;
  }
}

onMounted(() => void loadCapabilities());
onBeforeUnmount(() => {
  disposed = true;
  stopPolling();
});
</script>
