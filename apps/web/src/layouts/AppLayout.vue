<template>
  <div class="min-h-screen bg-white">
    <header class="border-b border-gray-200 px-6 py-4">
      <h1 class="text-xl font-semibold">GlyphQuire</h1>
    </header>
    <main class="p-6">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { RouterView } from "vue-router";
</script>
