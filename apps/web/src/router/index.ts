import { createRouter, createWebHistory } from "vue-router";
import { installAuthGuard } from "./guard.js";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      component: () => import("@/layouts/AuthLayout.vue"),
      children: [
        {
          path: "",
          name: "login",
          component: () => import("@/pages/LoginPage.vue"),
        },
      ],
    },
    {
      path: "/register",
      component: () => import("@/layouts/AuthLayout.vue"),
      children: [
        {
          path: "",
          name: "register",
          component: () => import("@/pages/RegisterPage.vue"),
        },
      ],
    },
    {
      path: "/",
      component: () => import("@/layouts/AppLayout.vue"),
      children: [
        {
          path: "",
          name: "home",
          component: () => import("@/pages/HomePage.vue"),
        },
        {
          path: "workspace/:workspaceId?",
          name: "workspace",
          component: () => import("@/pages/WorkbenchPage.vue"),
          meta: { fullBleed: true },
        },
        ...(import.meta.env.DEV
          ? [
              {
                path: "__readme-demo",
                name: "readme-demo",
                component: () => import("@/pages/ReadmeDemoPage.vue"),
              },
            ]
          : []),
      ],
    },
  ],
});

installAuthGuard(router);
