<template>
  <div class="bg-white" :class="isFullBleed ? 'flex h-screen flex-col' : 'min-h-screen'">
    <header v-if="!isFullBleed" class="border-b border-gray-200 px-6 py-4">
      <h1 class="text-xl font-semibold">GlyphQuire</h1>
    </header>
    <main :class="isFullBleed ? 'min-h-0 flex-1' : 'p-6'">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { RouterView, useRoute } from "vue-router";

const route = useRoute();
const isFullBleed = computed(() => route.meta.fullBleed === true);
</script>
