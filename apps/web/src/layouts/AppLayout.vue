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
import { computed, provide } from "vue";
import { RouterView, useRoute } from "vue-router";
import { THEME_INJECTION_KEY, useTheme } from "../themes/ThemeProvider.js";

const route = useRoute();
const isFullBleed = computed(() => route.meta.fullBleed === true);

// ThemeEditorPanel is rendered from the workbench (and teleports its DOM to
// body), but it still relies on Vue's logical component ancestry for its
// ThemeContext.  Provide one application-scoped context here so every page
// beneath AppLayout observes the same tokens, variants, and dark-mode state.
provide(THEME_INJECTION_KEY, useTheme());
</script>
