<template>
  <div class="space-y-6">
    <h2 class="text-xl font-semibold text-center">登入</h2>
    <form class="space-y-4" @submit.prevent>
      <div>
        <label for="email" class="block text-sm font-medium text-gray-700">Email</label>
        <input
          id="email"
          type="email"
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label for="password" class="block text-sm font-medium text-gray-700">密碼</label>
        <input
          id="password"
          type="password"
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
        />
      </div>
      <button
        type="submit"
        class="w-full rounded-md bg-black px-4 py-2 text-white hover:bg-gray-800"
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
import { RouterLink } from "vue-router";
</script>
