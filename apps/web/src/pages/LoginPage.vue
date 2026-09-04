<template>
  <div class="space-y-6">
    <h2 class="text-xl font-semibold text-center">登入</h2>
    <form class="space-y-4" @submit.prevent="onSubmit">
      <div>
        <label for="email" class="block text-sm font-medium text-foreground">Email</label>
        <input
          id="email"
          ref="emailRef"
          v-model="email"
          type="email"
          autocomplete="email"
          required
          class="mt-1 block w-full rounded-md border border-border px-3 py-2"
          placeholder="you@example.com"
          :aria-invalid="session.error ? 'true' : undefined"
          :aria-describedby="session.error ? 'login-error' : undefined"
        />
      </div>
      <div>
        <label for="password" class="block text-sm font-medium text-foreground">密碼</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          class="mt-1 block w-full rounded-md border border-border px-3 py-2"
          :aria-invalid="session.error ? 'true' : undefined"
          :aria-describedby="session.error ? 'login-error' : undefined"
        />
      </div>
      <p v-if="session.error" id="login-error" role="alert" class="text-sm text-danger">
        {{ session.error }}
      </p>
      <button
        type="submit"
        :disabled="session.pending"
        class="w-full rounded-md bg-accent px-4 py-2 text-accent-contrast hover:opacity-90 disabled:opacity-50"
      >
        登入
      </button>
    </form>
    <p class="text-center text-sm text-muted">
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
const emailRef = ref<HTMLInputElement | null>(null);

async function onSubmit(): Promise<void> {
  const ok = await session.signIn(email.value, password.value);
  if (ok && session.personalWorkspaceId) {
    await router.push(`/workspace/${session.personalWorkspaceId}`);
  } else {
    emailRef.value?.focus();
  }
}
</script>
