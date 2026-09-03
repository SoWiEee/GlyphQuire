<template>
  <div class="space-y-6">
    <h2 class="text-xl font-semibold text-center">登入</h2>
    <form class="space-y-4" @submit.prevent="onSubmit">
      <div>
        <label for="email" class="block text-sm font-medium text-gray-700">Email</label>
        <input
          id="email"
          v-model="email"
          type="email"
          autocomplete="email"
          required
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label for="password" class="block text-sm font-medium text-gray-700">密碼</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
        />
      </div>
      <p v-if="session.error" role="alert" class="text-sm text-red-600">{{ session.error }}</p>
      <button
        type="submit"
        :disabled="session.pending"
        class="w-full rounded-md bg-black px-4 py-2 text-white hover:bg-gray-800 disabled:opacity-50"
      >
        登入
      </button>
    </form>
    <p class="text-center text-sm text-gray-500">
      還沒有帳號？
      <RouterLink to="/register" class="text-black underline">註冊</RouterLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useSessionStore } from "../stores/session.js";

const session = useSessionStore();
const router = useRouter();
const email = ref("");
const password = ref("");

async function onSubmit(): Promise<void> {
  const ok = await session.signIn(email.value, password.value);
  if (ok && session.personalWorkspaceId) {
    await router.push(`/workspace/${session.personalWorkspaceId}`);
  }
}
</script>
