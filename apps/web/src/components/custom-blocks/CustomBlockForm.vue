<template>
  <form class="space-y-3" @submit.prevent="submit">
    <div class="grid grid-cols-2 gap-2">
      <label class="text-xs font-medium text-foreground"
        >Name
        <input
          v-model.trim="name"
          required
          pattern="[a-z][a-z0-9-]{0,63}"
          maxlength="64"
          class="mt-1 w-full rounded border px-2 py-1.5 text-sm"
          placeholder="reading-score"
        />
      </label>
      <label class="text-xs font-medium text-foreground"
        >Version
        <input
          v-model.number="version"
          type="number"
          min="1"
          required
          class="mt-1 w-full rounded border px-2 py-1.5 text-sm"
        />
      </label>
    </div>
    <div class="grid grid-cols-2 gap-2">
      <label class="text-xs font-medium text-foreground"
        >Preset
        <select v-model="preset" class="mt-1 w-full rounded border px-2 py-1.5 text-sm">
          <option v-for="value in presets" :key="value" :value="value">{{ value }}</option>
        </select>
      </label>
      <label class="text-xs font-medium text-foreground"
        >Icon
        <select v-model="icon" class="mt-1 w-full rounded border px-2 py-1.5 text-sm">
          <option v-for="value in icons" :key="value" :value="value">{{ value }}</option>
        </select>
      </label>
    </div>
    <div class="grid grid-cols-2 gap-2">
      <label class="text-xs font-medium text-foreground"
        >Kind
        <select v-model="kind" class="mt-1 w-full rounded border px-2 py-1.5 text-sm">
          <option value="container">Container</option>
          <option value="leaf">Leaf</option>
          <option value="text">Text</option>
        </select>
      </label>
      <label class="text-xs font-medium text-foreground"
        >Content
        <select v-model="contentPolicy" class="mt-1 w-full rounded border px-2 py-1.5 text-sm">
          <option value="none">No nested content</option>
          <option value="optional">Optional content</option>
          <option value="required">Required content</option>
        </select>
      </label>
      <label class="text-xs font-medium text-foreground"
        >Capability
        <select v-model="capability" class="mt-1 w-full rounded border px-2 py-1.5 text-sm">
          <option value="static">Static</option>
          <option value="interactive-ui">Interactive UI</option>
        </select>
      </label>
    </div>
    <label class="block text-xs font-medium text-foreground"
      >Props schema (JSON)
      <textarea
        v-model="propsJson"
        rows="5"
        class="mt-1 w-full rounded border px-2 py-1.5 font-mono text-xs"
        spellcheck="false"
        placeholder='{"label":{"type":"string","required":true,"maxLength":120}}'
      />
    </label>
    <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
    <div class="flex justify-end gap-2">
      <button type="button" class="rounded border px-3 py-1.5 text-xs" @click="emit('cancel')">
        Cancel
      </button>
      <button type="submit" class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-contrast">
        Save draft
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { customBlockDefinitionSchema } from "@glyphquire/api-contract";
import {
  CUSTOM_BLOCK_CAPABILITIES,
  CUSTOM_BLOCK_ICON_NAMES,
  CUSTOM_BLOCK_PRESETS,
  type CustomBlockDefinition,
} from "@glyphquire/theme-sdk";

const props = defineProps<{ initial?: CustomBlockDefinition }>();
const emit = defineEmits<{ save: [definition: CustomBlockDefinition]; cancel: [] }>();
const initial = props.initial;
const name = ref(initial?.name ?? "my-block");
const version = ref(initial?.version ?? 1);
const kind = ref<CustomBlockDefinition["kind"]>(initial?.kind ?? "container");
const preset = ref(initial?.preset ?? "card");
const icon = ref(initial?.icon ?? "info");
const contentPolicy = ref<CustomBlockDefinition["contentPolicy"]>(
  initial?.contentPolicy ?? "optional",
);
const capability = ref<(typeof CUSTOM_BLOCK_CAPABILITIES)[number]>(
  initial?.capabilities[0] ?? "static",
);
const propsJson = ref(JSON.stringify(initial?.propsSchema ?? {}, null, 2));
const error = ref<string | null>(null);
const presets = CUSTOM_BLOCK_PRESETS;
const icons = CUSTOM_BLOCK_ICON_NAMES;

function submit(): void {
  let parsedProps: unknown;
  try {
    parsedProps = JSON.parse(propsJson.value);
  } catch {
    error.value = "Props schema must be valid JSON.";
    return;
  }
  const result = customBlockDefinitionSchema.safeParse({
    name: name.value,
    version: version.value,
    kind: kind.value,
    propsSchema: parsedProps,
    contentPolicy: contentPolicy.value,
    icon: icon.value,
    preset: preset.value,
    capabilities: [capability.value],
  });
  if (!result.success) {
    error.value = result.error.issues[0]?.message ?? "Definition is invalid.";
    return;
  }
  error.value = null;
  emit("save", result.data);
}
</script>
