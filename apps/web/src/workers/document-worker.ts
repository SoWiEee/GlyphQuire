import { MAX_MARKDOWN_BYTES } from "@glyphquire/api-contract";
import {
  createDocumentEngine,
  type DocumentDiagnostic,
  type DocumentEngine,
  type ParseResult,
} from "@glyphquire/document-engine";

export const DOCUMENT_WORKER_PROTOCOL_VERSION = 1 as const;

export type DocumentOperation = "parse" | "validate";

export interface DocumentRequest {
  readonly protocolVersion: typeof DOCUMENT_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly operation: DocumentOperation;
  readonly markdown: string;
}

export interface DocumentSuccessResponse {
  readonly protocolVersion: typeof DOCUMENT_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly operation: DocumentOperation;
  readonly ok: true;
  readonly result: ParseResult;
  readonly canonicalMarkdown: string | null;
}

export interface DocumentFailureResponse {
  readonly protocolVersion: typeof DOCUMENT_WORKER_PROTOCOL_VERSION;
  readonly requestId: number | null;
  readonly operation: DocumentOperation | null;
  readonly ok: false;
  readonly error: {
    readonly code: "INVALID_REQUEST" | "PROCESSING_FAILED";
    readonly message: string;
  };
}

export type DocumentResponse = DocumentSuccessResponse | DocumentFailureResponse;

export interface DocumentWorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(response: DocumentResponse): void;
}

const REQUEST_KEYS = ["markdown", "operation", "protocolVersion", "requestId"] as const;
const SUCCESS_KEYS = [
  "canonicalMarkdown",
  "ok",
  "operation",
  "protocolVersion",
  "requestId",
  "result",
] as const;
const FAILURE_KEYS = ["error", "ok", "operation", "protocolVersion", "requestId"] as const;
const UTF8_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isOperation(value: unknown): value is DocumentOperation {
  return value === "parse" || value === "validate";
}

function isBoundedMarkdown(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_MARKDOWN_BYTES &&
    UTF8_ENCODER.encode(value).byteLength <= MAX_MARKDOWN_BYTES
  );
}

export function isDocumentRequest(value: unknown): value is DocumentRequest {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) return false;
  return (
    value.protocolVersion === DOCUMENT_WORKER_PROTOCOL_VERSION &&
    isRequestId(value.requestId) &&
    isOperation(value.operation) &&
    isBoundedMarkdown(value.markdown)
  );
}

function isDiagnostic(value: unknown): value is DocumentDiagnostic {
  if (!isRecord(value)) return false;
  if (
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    (value.severity !== "info" && value.severity !== "warning" && value.severity !== "error")
  ) {
    return false;
  }
  if (value.block !== undefined && typeof value.block !== "string") return false;
  if (value.attribute !== undefined && typeof value.attribute !== "string") return false;
  if (value.range !== undefined) {
    if (!isRecord(value.range)) return false;
    if (!Number.isSafeInteger(value.range.from) || !Number.isSafeInteger(value.range.to)) {
      return false;
    }
  }
  return true;
}

/** Rejects functions, accessors, class instances, cycles, and other non-message data. */
function isPlainMessageValue(root: unknown): boolean {
  const pending: unknown[] = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      continue;
    }
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get || descriptor.set || !("value" in descriptor)) return false;
      pending.push(descriptor.value);
    }
  }
  return true;
}

function isParseResult(value: unknown): value is ParseResult {
  if (!isRecord(value) || !isBoundedMarkdown(value.source)) return false;
  if (!Array.isArray(value.diagnostics) || !value.diagnostics.every(isDiagnostic)) return false;
  if (value.specVersion !== null && !Number.isSafeInteger(value.specVersion)) return false;
  if (value.ok === true) {
    return (
      isRecord(value.document) &&
      value.document.type === "document" &&
      value.document.specVersion === 1 &&
      Array.isArray(value.document.children) &&
      isPlainMessageValue(value.document)
    );
  }
  return value.ok === false && value.document === null;
}

export function isDocumentResponse(value: unknown): value is DocumentResponse {
  if (!isRecord(value) || value.protocolVersion !== DOCUMENT_WORKER_PROTOCOL_VERSION) return false;
  if (value.ok === true) {
    return (
      hasExactKeys(value, SUCCESS_KEYS) &&
      isRequestId(value.requestId) &&
      isOperation(value.operation) &&
      isParseResult(value.result) &&
      (value.canonicalMarkdown === null || isBoundedMarkdown(value.canonicalMarkdown))
    );
  }
  if (value.ok !== false || !hasExactKeys(value, FAILURE_KEYS)) return false;
  if (value.requestId !== null && !isRequestId(value.requestId)) return false;
  if (value.operation !== null && !isOperation(value.operation)) return false;
  if (!isRecord(value.error) || !hasExactKeys(value.error, ["code", "message"])) return false;
  return (
    (value.error.code === "INVALID_REQUEST" || value.error.code === "PROCESSING_FAILED") &&
    typeof value.error.message === "string"
  );
}

function invalidRequest(): DocumentFailureResponse {
  return {
    protocolVersion: DOCUMENT_WORKER_PROTOCOL_VERSION,
    requestId: null,
    operation: null,
    ok: false,
    error: { code: "INVALID_REQUEST", message: "Invalid document worker request" },
  };
}

function processingFailure(request: DocumentRequest): DocumentFailureResponse {
  return {
    protocolVersion: DOCUMENT_WORKER_PROTOCOL_VERSION,
    requestId: request.requestId,
    operation: request.operation,
    ok: false,
    error: { code: "PROCESSING_FAILED", message: "Document processing failed" },
  };
}

function combineDiagnostics(
  parsed: readonly DocumentDiagnostic[],
  validated: readonly DocumentDiagnostic[],
): DocumentDiagnostic[] {
  const combined: DocumentDiagnostic[] = [];
  const seen = new Set<string>();
  for (const item of [...parsed, ...validated]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(item);
  }
  return combined;
}

export function processDocumentRequest(
  value: unknown,
  engine: DocumentEngine = createDocumentEngine(),
): DocumentResponse {
  if (!isDocumentRequest(value)) return invalidRequest();
  try {
    const parsed = engine.parse(value.markdown);
    const result: ParseResult =
      value.operation === "validate" && parsed.ok
        ? {
            ...parsed,
            diagnostics: combineDiagnostics(
              parsed.diagnostics,
              engine.validate(parsed.document).diagnostics,
            ),
          }
        : parsed;
    const canonicalMarkdown = result.ok ? engine.serialize(result.document) : null;
    const response: DocumentSuccessResponse = {
      protocolVersion: DOCUMENT_WORKER_PROTOCOL_VERSION,
      requestId: value.requestId,
      operation: value.operation,
      ok: true,
      result,
      canonicalMarkdown,
    };
    return isDocumentResponse(response) ? response : processingFailure(value);
  } catch {
    return processingFailure(value);
  }
}

export function installDocumentWorker(scope: DocumentWorkerScope): void {
  scope.addEventListener("message", (event) => {
    scope.postMessage(processDocumentRequest(event.data));
  });
}

const possibleWorkerScope = globalThis as unknown as Partial<DocumentWorkerScope> & {
  document?: unknown;
};
if (
  possibleWorkerScope.document === undefined &&
  typeof possibleWorkerScope.addEventListener === "function" &&
  typeof possibleWorkerScope.postMessage === "function"
) {
  installDocumentWorker(possibleWorkerScope as DocumentWorkerScope);
}
