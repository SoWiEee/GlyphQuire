<template>
  <div class="space-y-6">
    <h2 class="text-xl font-semibold text-center">註冊</h2>
    <form class="space-y-4" @submit.prevent>
      <div>
        <label for="name" class="block text-sm font-medium text-gray-700">名稱</label>
        <input
          id="name"
          type="text"
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
          placeholder="你的名字"
        />
      </div>
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
        建立帳號
      </button>
    </form>
    <p class="text-center text-sm text-gray-500">
      已經有帳號？
      <RouterLink to="/login" class="text-black underline">登入</RouterLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>
