import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { createAppRuntime } from "./app.js";

export async function startApi() {
  const env = loadEnv();
  const { app, ready, close } = createAppRuntime(env);
  try {
    await ready;
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the initialization failure while making a best effort to
      // release the unopened runtime's owned database pool.
    }
    throw error;
  }

  return serve(
    {
      fetch: app.fetch,
      port: env.API_PORT,
    },
    (info) => {
      console.log(`GlyphQuire API running on http://localhost:${info.port}`);
    },
  );
}

interface StartupFailureLogEntry {
  event: "api_startup_failed";
  code: "SERVICE_UNAVAILABLE";
}

export async function runApiEntrypoint(
  start: () => Promise<unknown> = startApi,
  log: (entry: StartupFailureLogEntry) => void = (entry) => {
    console.error(JSON.stringify(entry));
  },
) {
  try {
    await start();
    return 0;
  } catch {
    try {
      log({ event: "api_startup_failed", code: "SERVICE_UNAVAILABLE" });
    } catch {
      // A logging outage cannot turn a failed startup into a successful one.
    }
    return 1;
  }
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  process.exitCode = await runApiEntrypoint();
}
