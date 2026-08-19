export interface QueuePort {
  enqueue<T>(
    taskName: string,
    payload: T,
    options?: EnqueueOptions,
  ): Promise<string>;
}

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
}
