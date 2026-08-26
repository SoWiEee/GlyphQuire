import {
  assertRegistryComplete,
  type DispatchSummary,
  type JobDispatcher,
  type JobRegistry,
} from "@glyphquire/queue";

export interface WorkerRuntimeOptions {
  clock?: () => number;
}

export class WorkerRuntime {
  private readonly controller = new AbortController();
  private readonly clock: () => number;
  private stopped = false;

  constructor(
    private readonly dispatcher: JobDispatcher,
    private readonly registry: JobRegistry,
    options: WorkerRuntimeOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
  }

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
    return this.dispatcher.dispatchBatch(this.registry, this.signal);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
  }
}
