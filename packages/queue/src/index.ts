export interface QueuePort {
  enqueue<T>(taskName: string, payload: T, options?: EnqueueOptions): Promise<string>;
}

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
}

export type {
  Clock,
  DispatchSummary,
  DocumentJob,
  DocumentJobDispatcher,
} from "./document-jobs.js";
export { isCurrentRevision } from "./document-jobs.js";
export {
  PostgresDocumentJobDispatcher,
  type PostgresDocumentJobDispatcherOptions,
} from "./outbox-dispatcher.js";
