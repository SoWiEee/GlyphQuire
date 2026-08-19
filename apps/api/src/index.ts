import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { createApp } from "./app.js";

const env = loadEnv();
const app = createApp(env);

serve(
  {
    fetch: app.fetch,
    port: env.API_PORT,
  },
  (info) => {
    console.log(`GlyphQuire API running on http://localhost:${info.port}`);
  },
);
