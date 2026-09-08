<template>
  <fieldset class="space-y-2">
    <legend class="text-xs font-semibold uppercase tracking-wide text-muted">Spacing</legend>
    <div v-for="key in spacingKeys" :key="key" class="flex items-center gap-2">
      <label :for="`spacing-${key}`" class="w-24 text-xs text-muted">{{ key }}</label>
      <input
        :id="`spacing-${key}`"
        type="range"
        min="0"
        max="4"
        step="0.125"
        :value="parseFloat(spacing[key])"
        :aria-valuemin="0"
        :aria-valuemax="4"
        :aria-valuenow="parseFloat(spacing[key])"
        class="flex-1"
        @input="emit('update:spacing', key, ($event.target as HTMLInputElement).value + 'rem')"
      />
      <span class="w-14 text-right text-xs text-muted">{{ spacing[key] }}</span>
    </div>
  </fieldset>
</template>

<script setup lang="ts">
defineProps<{
  spacing: Record<string, string>;
}>();

const emit = defineEmits<{
  "update:spacing": [key: string, value: string];
}>();

const spacingKeys = ["xs", "sm", "md", "lg", "xl", "2xl"];
</script>
