import { createDocumentEngine, type ParseResult } from "@glyphquire/document-engine";
import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  isDocumentResponse,
  processDocumentRequest,
  type DocumentOperation,
  type DocumentRequest,
  type DocumentSuccessResponse,
} from "../workers/document-worker.js";

export const DOCUMENT_WORKER_THRESHOLD_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const UTF8_ENCODER = new TextEncoder();

export type DocumentWorkerClientErrorCode =
  "CANCELLED" | "DISPOSED" | "MALFORMED_RESPONSE" | "TIMEOUT" | "WORKER_FAILED";

export class DocumentWorkerClientError extends Error {
  constructor(readonly code: DocumentWorkerClientErrorCode) {
    super(
      code === "CANCELLED"
        ? "Document analysis was superseded"
        : code === "DISPOSED"
          ? "Document worker client is disposed"
          : code === "TIMEOUT"
            ? "Document analysis timed out"
            : code === "MALFORMED_RESPONSE"
              ? "Document worker returned an invalid response"
              : "Document worker failed",
    );
    this.name = "DocumentWorkerClientError";
  }
}

export interface DocumentAnalysis {
  readonly result: ParseResult;
  readonly canonicalMarkdown: string | null;
}

export interface DocumentWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  terminate(): void;
}

export type DocumentWorkerFactory = () => DocumentWorkerLike;

export interface DocumentWorkerClientOptions {
  readonly workerFactory?: DocumentWorkerFactory;
  readonly timeoutMs?: number;
}

interface ActiveAnalysis {
  readonly version: number;
  readonly reject: (error: DocumentWorkerClientError) => void;
  settled: boolean;
}

interface PendingRequest {
  readonly analysisVersion: number;
  readonly request: DocumentRequest;
  readonly resolve: (response: DocumentSuccessResponse) => void;
  readonly reject: (error: DocumentWorkerClientError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

function defaultWorkerFactory(): DocumentWorkerLike {
  return new Worker(new URL("../workers/document-worker.ts", import.meta.url), {
    type: "module",
    name: "glyphquire-document-worker",
  });
}

export class DocumentWorkerClient {
  private readonly workerFactory: DocumentWorkerFactory;
  private readonly timeoutMs: number;
  private readonly engine = createDocumentEngine();
  private readonly pending = new Map<number, PendingRequest>();
  private worker: DocumentWorkerLike | undefined;
  private nextRequestId = 0;
  private analysisVersion = 0;
  private active: ActiveAnalysis | undefined;
  private disposed = false;

  private readonly onMessage = (event: Event): void => {
    const data = (event as MessageEvent<unknown>).data;
    if (!isDocumentResponse(data)) {
      this.failWorker(new DocumentWorkerClientError("MALFORMED_RESPONSE"));
      return;
    }
    if (data.requestId === null) {
      this.failWorker(new DocumentWorkerClientError("MALFORMED_RESPONSE"));
      return;
    }
    const pending = this.pending.get(data.requestId);
    if (!pending) return;
    if (
      data.operation !== pending.request.operation ||
      (!data.ok && data.requestId !== pending.request.requestId) ||
      (data.ok && data.result.source !== pending.request.markdown)
    ) {
      this.failWorker(new DocumentWorkerClientError("MALFORMED_RESPONSE"));
      return;
    }
    this.pending.delete(data.requestId);
    clearTimeout(pending.timeout);
    if (!data.ok) {
      pending.reject(new DocumentWorkerClientError("WORKER_FAILED"));
      return;
    }
    pending.resolve(data);
  };

  private readonly onWorkerFailure = (): void => {
    this.failWorker(new DocumentWorkerClientError("WORKER_FAILED"));
  };

  constructor(options: DocumentWorkerClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Document worker timeout must be a positive integer");
    }
  }

  parseAndValidate(markdown: string): Promise<DocumentAnalysis> {
    if (this.disposed) {
      return Promise.reject(new DocumentWorkerClientError("DISPOSED"));
    }
    this.cancelActive(new DocumentWorkerClientError("CANCELLED"));
    const version = ++this.analysisVersion;
    return new Promise<DocumentAnalysis>((resolve, reject) => {
      const active: ActiveAnalysis = { version, reject, settled: false };
      this.active = active;
      void this.runAnalysis(markdown, version).then(
        (analysis) => {
          if (active.settled || this.active !== active || this.disposed) return;
          active.settled = true;
          this.active = undefined;
          resolve(analysis);
        },
        (error: unknown) => {
          if (active.settled || this.active !== active) return;
          active.settled = true;
          this.active = undefined;
          reject(
            error instanceof DocumentWorkerClientError
              ? error
              : new DocumentWorkerClientError("WORKER_FAILED"),
          );
        },
      );
    });
  }

  cancel(): void {
    if (this.disposed) return;
    this.cancelActive(new DocumentWorkerClientError("CANCELLED"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActive(new DocumentWorkerClientError("DISPOSED"));
    this.resetWorker();
  }

  private async runAnalysis(markdown: string, version: number): Promise<DocumentAnalysis> {
    const parsed = await this.request("parse", markdown, version);
    this.requireLatest(version);
    if (!parsed.result.ok) {
      return { result: parsed.result, canonicalMarkdown: null };
    }
    const validated = await this.request("validate", markdown, version);
    this.requireLatest(version);
    return { result: validated.result, canonicalMarkdown: validated.canonicalMarkdown };
  }

  private request(
    operation: DocumentOperation,
    markdown: string,
    analysisVersion: number,
  ): Promise<DocumentSuccessResponse> {
    this.requireLatest(analysisVersion);
    const request: DocumentRequest = {
      protocolVersion: DOCUMENT_WORKER_PROTOCOL_VERSION,
      requestId: this.allocateRequestId(),
      operation,
      markdown,
    };
    if (UTF8_ENCODER.encode(markdown).byteLength <= DOCUMENT_WORKER_THRESHOLD_BYTES) {
      const response = processDocumentRequest(request, this.engine);
      if (!response.ok) return Promise.reject(new DocumentWorkerClientError("WORKER_FAILED"));
      return Promise.resolve(response);
    }
    return this.requestWorker(request, analysisVersion);
  }

  private requestWorker(
    request: DocumentRequest,
    analysisVersion: number,
  ): Promise<DocumentSuccessResponse> {
    const worker = this.requireWorker();
    return new Promise<DocumentSuccessResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(request.requestId)) return;
        this.pending.delete(request.requestId);
        reject(new DocumentWorkerClientError("TIMEOUT"));
        this.failWorker(new DocumentWorkerClientError("TIMEOUT"));
      }, this.timeoutMs);
      this.pending.set(request.requestId, {
        analysisVersion,
        request,
        resolve,
        reject,
        timeout,
      });
      try {
        worker.postMessage(request);
      } catch {
        this.pending.delete(request.requestId);
        clearTimeout(timeout);
        reject(new DocumentWorkerClientError("WORKER_FAILED"));
        this.failWorker(new DocumentWorkerClientError("WORKER_FAILED"));
      }
    });
  }

  private allocateRequestId(): number {
    if (this.nextRequestId >= Number.MAX_SAFE_INTEGER) {
      throw new DocumentWorkerClientError("WORKER_FAILED");
    }
    this.nextRequestId += 1;
    return this.nextRequestId;
  }

  private requireLatest(version: number): void {
    if (this.disposed) throw new DocumentWorkerClientError("DISPOSED");
    if (this.active?.version !== version) throw new DocumentWorkerClientError("CANCELLED");
  }

  private requireWorker(): DocumentWorkerLike {
    if (this.worker) return this.worker;
    let worker: DocumentWorkerLike;
    try {
      worker = this.workerFactory();
      worker.addEventListener("message", this.onMessage);
      worker.addEventListener("error", this.onWorkerFailure);
      worker.addEventListener("messageerror", this.onWorkerFailure);
    } catch {
      throw new DocumentWorkerClientError("WORKER_FAILED");
    }
    this.worker = worker;
    return worker;
  }

  private cancelActive(error: DocumentWorkerClientError): void {
    const active = this.active;
    if (active && !active.settled) {
      active.settled = true;
      active.reject(error);
    }
    this.active = undefined;
    let hadPendingWorkerRequest = false;
    for (const [requestId, pending] of this.pending) {
      if (pending.analysisVersion !== active?.version) continue;
      hadPendingWorkerRequest = true;
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    if (hadPendingWorkerRequest) this.resetWorker();
  }

  private failWorker(error: DocumentWorkerClientError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.resetWorker();
  }

  private resetWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    worker.removeEventListener("message", this.onMessage);
    worker.removeEventListener("error", this.onWorkerFailure);
    worker.removeEventListener("messageerror", this.onWorkerFailure);
    worker.terminate();
  }
}
