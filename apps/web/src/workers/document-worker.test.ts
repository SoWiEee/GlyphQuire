import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  installDocumentWorker,
  processDocumentRequest,
  type DocumentRequest,
  type DocumentResponse,
} from "./document-worker.js";
import {
  DOCUMENT_WORKER_THRESHOLD_BYTES,
  DocumentWorkerClient,
  DocumentWorkerClientError,
  type DocumentWorkerLike,
} from "../editors/DocumentWorkerClient.js";

const FRONTMATTER = "---\nglyphquire-spec: 1\n---\n\n";

function markdownOfBytes(bytes: number): string {
  if (bytes < FRONTMATTER.length) throw new Error("Fixture is too small");
  return `${FRONTMATTER}${"a".repeat(bytes - FRONTMATTER.length)}`;
}

class ControlledWorker implements DocumentWorkerLike {
  readonly requests: DocumentRequest[] = [];
  terminateCalls = 0;
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  private readonly errorListeners = new Set<(event: Event) => void>();
  private readonly messageErrorListeners = new Set<(event: MessageEvent<unknown>) => void>();

  postMessage(message: unknown): void {
    this.requests.push(structuredClone(message) as DocumentRequest);
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void {
    if (type === "message") {
      this.messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
    } else if (type === "error") {
      this.errorListeners.add(listener);
    } else {
      this.messageErrorListeners.add(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void {
    if (type === "message") {
      this.messageListeners.delete(listener as (event: MessageEvent<unknown>) => void);
    } else if (type === "error") {
      this.errorListeners.delete(listener);
    } else {
      this.messageErrorListeners.delete(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  respond(response: unknown): void {
    for (const listener of this.messageListeners) {
      listener(new MessageEvent("message", { data: structuredClone(response) }));
    }
  }

  respondTo(request: DocumentRequest): void {
    this.respond(processDocumentRequest(request));
  }

  fail(): void {
    for (const listener of this.errorListeners) listener(new Event("error"));
  }

  failClone(): void {
    for (const listener of this.messageErrorListeners) {
      listener(new MessageEvent("messageerror", { data: undefined }));
    }
  }
}

async function advanceOneOperation(worker: ControlledWorker): Promise<DocumentRequest> {
  const request = worker.requests.at(-1);
  if (!request) throw new Error("No worker request to answer");
  worker.respondTo(request);
  await Promise.resolve();
  return request;
}

describe("document worker contract", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns only structured-clone-safe, versioned parse and validation envelopes", () => {
    const markdown = `${FRONTMATTER}hello`;
    const parseResponse = processDocumentRequest({
      protocolVersion: DOCUMENT_WORKER_PROTOCOL_VERSION,
      requestId: 1,
      operation: "parse",
      markdown,
    });
    const validationResponse = processDocumentRequest({
      protocolVersion: DOCUMENT_WORKER_PROTOCOL_VERSION,
      requestId: 2,
      operation: "validate",
      markdown,
    });

    expect(structuredClone(parseResponse)).toEqual(parseResponse);
    expect(structuredClone(validationResponse)).toEqual(validationResponse);
    expect(parseResponse).toMatchObject({
      protocolVersion: 1,
      requestId: 1,
      operation: "parse",
      ok: true,
      result: { ok: true, source: markdown },
    });
    expect(validationResponse).toMatchObject({
      protocolVersion: 1,
      requestId: 2,
      operation: "validate",
      ok: true,
      result: { ok: true, source: markdown },
    });
  });

  it.each([
    null,
    {},
    { protocolVersion: 2, requestId: 1, operation: "parse", markdown: FRONTMATTER },
    { protocolVersion: 1, requestId: 0, operation: "parse", markdown: FRONTMATTER },
    { protocolVersion: 1, requestId: 1.5, operation: "parse", markdown: FRONTMATTER },
    { protocolVersion: 1, requestId: 1, operation: "serialize", markdown: FRONTMATTER },
    { protocolVersion: 1, requestId: 1, operation: "parse", markdown: 123 },
  ])("rejects malformed worker input without echoing attacker data: %j", (message) => {
    const response = processDocumentRequest(message);

    expect(structuredClone(response)).toEqual(response);
    expect(response).toEqual({
      protocolVersion: DOCUMENT_WORKER_PROTOCOL_VERSION,
      requestId: null,
      operation: null,
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Invalid document worker request" },
    });
  });

  it("installs one message handler that validates before posting a response", () => {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const posted: DocumentResponse[] = [];
    const scope = {
      addEventListener: vi.fn((_type: "message", next: (event: MessageEvent<unknown>) => void) => {
        listener = next;
      }),
      postMessage: vi.fn((response: DocumentResponse) => posted.push(response)),
    };

    installDocumentWorker(scope);
    listener?.(new MessageEvent("message", { data: { requestId: "forged" } }));

    expect(scope.addEventListener).toHaveBeenCalledOnce();
    expect(posted).toEqual([
      {
        protocolVersion: 1,
        requestId: null,
        operation: null,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Invalid document worker request" },
      },
    ]);
  });

  it("keeps exactly 100 KiB on the caller and moves 100 KiB plus one byte to a Worker", async () => {
    const worker = new ControlledWorker();
    const factory = vi.fn(() => worker);
    const client = new DocumentWorkerClient({ workerFactory: factory });

    const boundary = markdownOfBytes(DOCUMENT_WORKER_THRESHOLD_BYTES);
    const local = await client.parseAndValidate(boundary);
    expect(local.result.source).toBe(boundary);
    expect(factory).not.toHaveBeenCalled();

    const overBoundary = markdownOfBytes(DOCUMENT_WORKER_THRESHOLD_BYTES + 1);
    const pending = client.parseAndValidate(overBoundary);
    const parseRequest = await advanceOneOperation(worker);
    const validationRequest = await advanceOneOperation(worker);

    await expect(pending).resolves.toMatchObject({ result: { ok: true, source: overBoundary } });
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.requests.map(({ requestId, operation, markdown }) => ({
      requestId,
      operation,
      bytes: new TextEncoder().encode(markdown).byteLength,
    }))).toEqual([
      { requestId: parseRequest.requestId, operation: "parse", bytes: 102_401 },
      { requestId: validationRequest.requestId, operation: "validate", bytes: 102_401 },
    ]);
    expect(validationRequest.requestId).toBe(parseRequest.requestId + 1);
  });

  it("transfers a 1 MiB document through ordered parse then validate requests without changing source", async () => {
    const worker = new ControlledWorker();
    const client = new DocumentWorkerClient({ workerFactory: () => worker });
    const markdown = markdownOfBytes(1024 * 1024);

    const pending = client.parseAndValidate(markdown);
    const parseRequest = await advanceOneOperation(worker);
    expect(worker.requests).toHaveLength(2);
    const validateRequest = await advanceOneOperation(worker);

    const analysis = await pending;
    expect(worker.requests.map((request) => request.operation)).toEqual(["parse", "validate"]);
    expect(validateRequest.requestId).toBeGreaterThan(parseRequest.requestId);
    expect(analysis.result.source).toBe(markdown);
    expect(analysis.canonicalMarkdown?.startsWith(FRONTMATTER)).toBe(true);
  });

  it("uses the platform Worker constructor for oversized production requests", async () => {
    const worker = new ControlledWorker();
    const WorkerConstructor = vi.fn(function WorkerConstructor() {
      return worker;
    });
    vi.stubGlobal("Worker", WorkerConstructor);
    const client = new DocumentWorkerClient();

    const pending = client.parseAndValidate(markdownOfBytes(DOCUMENT_WORKER_THRESHOLD_BYTES + 1));
    await advanceOneOperation(worker);
    await advanceOneOperation(worker);
    await pending;

    expect(WorkerConstructor).toHaveBeenCalledOnce();
    const [url, options] = WorkerConstructor.mock.calls[0] ?? [];
    expect(String(url)).toContain("document-worker");
    expect(options).toEqual({ type: "module", name: "glyphquire-document-worker" });
  });

  it("cancels the prior analysis and ignores its stale response when a newer request starts", async () => {
    const worker = new ControlledWorker();
    const client = new DocumentWorkerClient({ workerFactory: () => worker });
    const staleMarkdown = markdownOfBytes(DOCUMENT_WORKER_THRESHOLD_BYTES + 1);
    const latestMarkdown = markdownOfBytes(DOCUMENT_WORKER_THRESHOLD_BYTES + 2);

    const stale = client.parseAndValidate(staleMarkdown);
    const staleRequest = worker.requests[0];
    if (!staleRequest) throw new Error("Missing stale request");
    const latest = client.parseAndValidate(latestMarkdown);
    const latestParse = worker.requests[1];
    if (!latestParse) throw new Error("Missing latest request");

    await expect(stale).rejects.toMatchObject({ code: "CANCELLED" });
    worker.respondTo(staleRequest);
    worker.respondTo(latestParse);
    await Promise.resolve();
    const latestValidate = worker.requests[2];
    if (!latestValidate) throw new Error("Missing latest validation request");
    worker.respondTo(latestValidate);

    await expect(latest).resolves.toMatchObject({ result: { source: latestMarkdown } });
  });

  it.each(["error", "messageerror"] as const)(
    "fails closed and terminates the worker on %s",
    async (failure) => {
      const worker = new ControlledWorker();
      const client = new DocumentWorkerClient({ workerFactory: () => worker });
      const pending = client.parseAndValidate(
        markdownOfBytes(DOCUMENT_WORKER_THRESHOLD_BYTES + 1),
      );

      if (failure === "error") { worker.fail(); } else { worker.failClone(); }

      await expect(pending).rejects.toMatchObject({ code: "WORKER_FAILED" });
      expect(worker.terminateCalls).toBe(1);
    },
  );

  it("rejects a malformed or mismatched response and never treats it as validation", async () => {
    const worker = new ControlledWorker();
    const client = new DocumentWorkerClient({ workerFactory: () => worker });
    const pending = client.parseAndValidate(markdownOfBytes(DOCUMENT_WORKER_THRESHOLD_BYTES + 1));
    const request = worker.requests[0];
    if (!request) throw new Error("Missing request");

    worker.respond({
      protocolVersion: 1,
      requestId: request.requestId,
      operation: "validate",
      ok: true,
      result: { ok: true, source: request.markdown },
      canonicalMarkdown: request.markdown,
    });

    await expect(pending).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(worker.terminateCalls).toBe(1);
  });

  it("times out, terminates, and rejects instead of falling back to main-thread parsing", async () => {
    vi.useFakeTimers();
    const worker = new ControlledWorker();
    const factory = vi.fn(() => worker);
    const client = new DocumentWorkerClient({ workerFactory: factory, timeoutMs: 25 });
    const pending = client.parseAndValidate(markdownOfBytes(DOCUMENT_WORKER_THRESHOLD_BYTES + 1));
    const rejection = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(worker.terminateCalls).toBe(1);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("cancels pending work on dispose and ignores every late response", async () => {
    const worker = new ControlledWorker();
    const factory = vi.fn(() => worker);
    const client = new DocumentWorkerClient({ workerFactory: factory });
    const pending = client.parseAndValidate(markdownOfBytes(DOCUMENT_WORKER_THRESHOLD_BYTES + 1));
    const request = worker.requests[0];
    if (!request) throw new Error("Missing request");

    client.dispose();
    worker.respondTo(request);

    await expect(pending).rejects.toMatchObject({ code: "DISPOSED" });
    await expect(client.parseAndValidate(FRONTMATTER)).rejects.toBeInstanceOf(
      DocumentWorkerClientError,
    );
    expect(worker.terminateCalls).toBe(1);
    expect(factory).toHaveBeenCalledOnce();
  });
});
