import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5174, strictPort: true, cors: true },
  build: { outDir: "dist", target: "esnext" },
});
