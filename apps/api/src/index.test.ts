import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAppRuntime: vi.fn(),
  loadEnv: vi.fn(),
  serve: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: mocks.serve }));
vi.mock("./env.js", () => ({ loadEnv: mocks.loadEnv }));
vi.mock("./app.js", () => ({ createAppRuntime: mocks.createAppRuntime }));

import { runApiEntrypoint, startApi } from "./index.js";

const productionEnv = {
  API_PORT: 4321,
  PRODUCTION: true,
};

describe("production API startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadEnv.mockReturnValue(productionEnv);
  });

  it("rejects startup and never listens when limiter readiness rejects", async () => {
    const initializationError = new Error("shared limiter initialization failed");
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.createAppRuntime.mockReturnValue({
      app: { fetch: vi.fn() },
      ready: Promise.reject(initializationError),
      close,
    });

    await expect(startApi()).rejects.toBe(initializationError);

    expect(mocks.serve).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("turns startup rejection into a fixed scrubbed nonzero exit result", async () => {
    const entries: unknown[] = [];
    const exitCode = await runApiEntrypoint(
      async () => {
        throw new Error("DATABASE_PASSWORD SQL_SENTINEL STACK_SENTINEL");
      },
      (entry) => entries.push(entry),
    );

    expect(exitCode).toBe(1);
    expect(entries).toEqual([
      {
        event: "api_startup_failed",
        code: "SERVICE_UNAVAILABLE",
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("DATABASE_PASSWORD");
    expect(JSON.stringify(entries)).not.toContain("SQL_SENTINEL");
    expect(JSON.stringify(entries)).not.toContain("STACK_SENTINEL");
  });

  it("does not listen until readiness succeeds, then serves the ready app", async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const fetch = vi.fn();
    const server = { close: vi.fn() };
    mocks.createAppRuntime.mockReturnValue({ app: { fetch }, ready, close: vi.fn() });
    mocks.serve.mockReturnValue(server);

    const starting = startApi();
    await Promise.resolve();
    expect(mocks.serve).not.toHaveBeenCalled();

    markReady();
    await expect(starting).resolves.toBe(server);
    expect(mocks.createAppRuntime).toHaveBeenCalledWith(productionEnv);
    expect(mocks.serve).toHaveBeenCalledWith({ fetch, port: 4321 }, expect.any(Function));
  });
});
