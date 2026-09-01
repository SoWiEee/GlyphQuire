<template>
  <aside
    class="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
    role="status"
  >
    <div class="flex items-start gap-2">
      <GqIcon name="circle-alert" size="sm" class="mt-0.5 shrink-0" />
      <div>
        <p class="font-medium">Custom Block unavailable</p>
        <p class="mt-1 text-xs">
          {{
            name
              ? `“${name}” is not available in this workspace.`
              : "This block definition is unavailable."
          }}
        </p>
        <p class="mt-1 text-xs text-amber-800">
          The authored Markdown is preserved in Source mode.
        </p>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import GqIcon from "../icons/GqIcon.vue";

defineProps<{ name?: string }>();
</script>
