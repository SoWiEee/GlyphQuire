import {
  assertRegistryComplete,
  type DispatchSummary,
  type JobDispatcher,
  type JobRegistry,
} from "@glyphquire/queue";

export interface WorkerRuntimeOptions {
  clock?: () => number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  wait?: WorkerWait;
}

export type WorkerWait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 60_000;

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class WorkerRuntime {
  private readonly controller = new AbortController();
  private readonly clock: () => number;
  private readonly pollIntervalMs: number;
  private readonly wait: WorkerWait;
  private readonly externalSignal: AbortSignal | undefined;
  private inFlight: Promise<DispatchSummary> | undefined;
  private loop: Promise<void> | undefined;
  private shutdownResult: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly dispatcher: JobDispatcher,
    private readonly registry: JobRegistry,
    options: WorkerRuntimeOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (
      !Number.isInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 1 ||
      this.pollIntervalMs > MAX_POLL_INTERVAL_MS
    ) {
      throw new Error("Invalid worker poll interval");
    }
    this.wait = options.wait ?? defaultWait;
    this.externalSignal = options.signal;
    if (this.externalSignal?.aborted) {
      this.stop();
    } else {
      this.externalSignal?.addEventListener("abort", this.handleExternalAbort, { once: true });
    }
  }

  private readonly handleExternalAbort = () => {
    this.stop();
  };

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  now(): number {
    return this.clock();
  }

  assertCanActivate(): void {
    assertRegistryComplete(this.registry);
  }

  async dispatchOnce(): Promise<DispatchSummary> {
    if (this.stopped) throw new Error("Worker runtime is stopped");
    if (this.inFlight) return this.inFlight;

    const dispatch = this.dispatcher.dispatchBatch(this.registry, this.signal);
    this.inFlight = dispatch;
    try {
      return await dispatch;
    } finally {
      if (this.inFlight === dispatch) this.inFlight = undefined;
    }
  }

  run(): Promise<void> {
    this.loop ??= this.runLoop();
    return this.loop;
  }

  private async runLoop(): Promise<void> {
    this.assertCanActivate();
    while (!this.stopped) {
      try {
        await this.dispatchOnce();
      } catch (error) {
        if (this.stopped) return;
        throw error;
      }
      if (this.stopped) return;
      try {
        await this.wait(this.pollIntervalMs, this.signal);
      } catch (error) {
        if (this.stopped) return;
        throw error;
      }
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.externalSignal?.removeEventListener("abort", this.handleExternalAbort);
    this.controller.abort();
  }

  shutdown(): Promise<void> {
    if (this.shutdownResult) return this.shutdownResult;
    this.stop();
    const pending = [...new Set([this.loop, this.inFlight].filter(Boolean))] as Promise<unknown>[];
    this.shutdownResult = Promise.allSettled(pending).then(() => undefined);
    return this.shutdownResult;
  }
}
