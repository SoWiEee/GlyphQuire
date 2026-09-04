<template>
  <div class="space-y-6">
    <h2 class="text-xl font-semibold text-center">註冊</h2>
    <form class="space-y-4" @submit.prevent="onSubmit">
      <div>
        <label for="name" class="block text-sm font-medium text-foreground">名稱</label>
        <input
          id="name"
          ref="nameRef"
          v-model="name"
          type="text"
          autocomplete="name"
          required
          class="mt-1 block w-full rounded-md border border-border px-3 py-2"
          placeholder="你的名字"
          :aria-invalid="session.error ? 'true' : undefined"
          :aria-describedby="session.error ? 'register-error' : undefined"
        />
      </div>
      <div>
        <label for="email" class="block text-sm font-medium text-foreground">Email</label>
        <input
          id="email"
          v-model="email"
          type="email"
          autocomplete="email"
          required
          class="mt-1 block w-full rounded-md border border-border px-3 py-2"
          placeholder="you@example.com"
          :aria-invalid="session.error ? 'true' : undefined"
          :aria-describedby="session.error ? 'register-error' : undefined"
        />
      </div>
      <div>
        <label for="password" class="block text-sm font-medium text-foreground">密碼</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="new-password"
          required
          class="mt-1 block w-full rounded-md border border-border px-3 py-2"
          :aria-invalid="session.error ? 'true' : undefined"
          :aria-describedby="session.error ? 'register-error' : undefined"
        />
      </div>
      <p v-if="session.error" id="register-error" role="alert" class="text-sm text-danger">
        {{ session.error }}
      </p>
      <button
        type="submit"
        :disabled="session.pending"
        class="w-full rounded-md bg-accent px-4 py-2 text-accent-contrast hover:opacity-90 disabled:opacity-50"
      >
        建立帳號
      </button>
    </form>
    <p class="text-center text-sm text-muted">
      已經有帳號？
      <RouterLink to="/login" class="text-black underline">登入</RouterLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useSessionStore } from "../stores/session.js";

const session = useSessionStore();
const router = useRouter();
const name = ref("");
const email = ref("");
const password = ref("");
const nameRef = ref<HTMLInputElement | null>(null);

async function onSubmit(): Promise<void> {
  const ok = await session.signUp(email.value, password.value, name.value);
  if (ok && session.personalWorkspaceId) {
    await router.push(`/workspace/${session.personalWorkspaceId}`);
  } else {
    nameRef.value?.focus();
  }
}
</script>
