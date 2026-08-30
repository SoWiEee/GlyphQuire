<template>
  <section aria-label="Asset manager" class="space-y-3 rounded border border-gray-200 p-4">
    <h2 class="text-sm font-semibold text-gray-900">Assets</h2>
    <label class="block text-sm text-gray-700">
      Asset file
      <input
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label="Asset file"
        class="mt-1 block w-full text-sm"
        @change="selectFile"
      />
    </label>
    <button
      type="button"
      aria-label="Upload asset"
      :disabled="!file || store.busy"
      class="rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      @click="upload"
    >
      Upload asset
    </button>

    <ul v-if="workspaceAssets.length" aria-label="Uploaded assets" class="space-y-2 text-sm">
      <li v-for="asset in workspaceAssets" :key="asset.id" class="rounded bg-gray-50 p-2">
        <span>{{ asset.originalName }}</span>
        <code data-testid="asset-reference" class="ml-2 select-all">asset://{{ asset.id }}</code>
        <button
          type="button"
          class="ml-2 underline"
          :aria-label="`Copy asset reference for ${asset.originalName}`"
          @click="copyReference(asset.id)"
        >
          Copy reference
        </button>
      </li>
    </ul>
    <p v-if="selectionError" role="alert" class="text-sm text-red-700">{{ selectionError }}</p>
    <p v-else-if="store.error" role="alert" class="text-sm text-red-700">{{ store.error }}</p>
    <p aria-live="polite" class="sr-only">{{ status }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { usePhase5Store } from "../../stores/phase5.js";

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const PASSIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const props = defineProps<{ workspaceId: string }>();
const emit = defineEmits<{ reference: [reference: string] }>();
const store = usePhase5Store();
const file = ref<File | null>(null);
const selectionError = ref<string | null>(null);
const status = ref("");
const workspaceAssets = computed(() =>
  store.assets.filter(
    (asset) => asset.workspaceId === props.workspaceId && asset.deletedAt === null,
  ),
);

function selectFile(event: Event): void {
  const selected = (event.target as HTMLInputElement).files?.[0] ?? null;
  if (
    !selected ||
    selected.size < 1 ||
    selected.size > MAX_ASSET_BYTES ||
    !PASSIVE_IMAGE_TYPES.has(selected.type)
  ) {
    file.value = null;
    selectionError.value = "Choose a PNG, JPEG, GIF, or WebP file up to 5 MiB.";
    return;
  }
  file.value = selected;
  selectionError.value = null;
}

async function upload(): Promise<void> {
  const selected = file.value;
  if (!selected) return;
  try {
    const result = await store.uploadAsset({ workspaceId: props.workspaceId, file: selected });
    const reference = `asset://${result.id}`;
    status.value = "Asset uploaded. Logical reference ready.";
    emit("reference", reference);
    file.value = null;
  } catch {
    status.value = "Asset upload failed.";
  }
}

async function copyReference(assetId: string): Promise<void> {
  const reference = `asset://${assetId}`;
  emit("reference", reference);
  try {
    await navigator.clipboard?.writeText(reference);
    status.value = "Asset reference copied.";
  } catch {
    status.value = "Asset reference ready to copy.";
  }
}
</script>
