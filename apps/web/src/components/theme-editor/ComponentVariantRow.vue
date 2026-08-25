<template>
  <div class="flex items-center gap-2">
    <label :for="`variant-${componentName}`" class="w-24 text-xs text-gray-600">{{
      componentName
    }}</label>
    <select
      :id="`variant-${componentName}`"
      :value="selectedVariant"
      class="flex-1 rounded border border-gray-300 px-1.5 py-0.5 text-xs"
      @change="emit('update:variant', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in options" :key="option" :value="option">{{ option }}</option>
    </select>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  componentName: string;
  selectedVariant: string;
  options: string[];
}>();

const emit = defineEmits<{
  "update:variant": [value: string];
}>();
</script>
