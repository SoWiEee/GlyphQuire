import { randomUUID } from "node:crypto";
import { API_ERROR_CODES, type ApiErrorCode } from "@glyphquire/api-contract";
import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const allowedCodes = new Set<string>(API_ERROR_CODES);

const defaultMessages: Record<ApiErrorCode, string> = {
  NOTE_NOT_FOUND: "Note not found",
  REVISION_CONFLICT: "The note has changed",
  DOCUMENT_INVALID: "The request is invalid",
  DOCUMENT_TOO_LARGE: "The request body is too large",
  OPERATION_REUSED: "The operation identifier was already used",
  RATE_LIMITED: "Too many requests",
  SERVICE_UNAVAILABLE: "The service is temporarily unavailable",
  ASSET_INVALID: "The asset request is invalid",
  SEARCH_UNAVAILABLE: "Search is temporarily unavailable",
  IMPORT_INVALID: "The import is invalid",
  EXPORT_FAILED: "The export failed",
  SHARE_NOT_FOUND: "Share link not found",
  JOB_INVALID: "The job is invalid",
  JOB_FAILED: "The job failed",
};

export type PublicErrorMessage =
  | "The request is not allowed"
  | "The request is invalid"
  | "The request body is too large"
  | "Note not found"
  | "The note has changed"
  | "The operation identifier was already used"
  | "Too many requests"
  | "The service is temporarily unavailable"
  | "The asset request is invalid"
  | "Search is temporarily unavailable"
  | "The import is invalid"
  | "The export failed"
  | "Share link not found"
  | "The job is invalid"
  | "The job failed";

export interface SecurityLogEntry {
  event: "api_request_failed";
  requestId: string;
  code: ApiErrorCode;
  status: number;
  method: string;
  routeClass: "auth" | "api_v1" | "health" | "other";
}

export interface SecurityLogger {
  error(entry: SecurityLogEntry): void;
}

const defaultLogger: SecurityLogger = {
  error(entry) {
    console.error(JSON.stringify(entry));
  },
};

export class PublicApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: ContentfulStatusCode;
  readonly publicMessage: PublicErrorMessage;

  constructor(
    code: ApiErrorCode,
    status: ContentfulStatusCode,
    publicMessage: PublicErrorMessage = defaultMessages[code] as PublicErrorMessage,
  ) {
    super(code);
    this.name = "PublicApiError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function requestIdFromContext(context: Parameters<ErrorHandler>[1]) {
  const candidate = context.get("requestId");
  return typeof candidate === "string" ? candidate : randomUUID();
}

function publicError(error: unknown) {
  if (error instanceof PublicApiError && allowedCodes.has(error.code)) {
    return {
      code: error.code,
      message: error.publicMessage,
      status: error.status,
    };
  }

  return {
    code: "SERVICE_UNAVAILABLE" as const,
    message: defaultMessages.SERVICE_UNAVAILABLE,
    status: 503 as const,
  };
}

function routeClass(path: string): SecurityLogEntry["routeClass"] {
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return "auth";
  if (path === "/api/v1" || path.startsWith("/api/v1/")) return "api_v1";
  if (path === "/api/health") return "health";
  return "other";
}

export function createErrorHandler(logger: SecurityLogger = defaultLogger): ErrorHandler {
  return (error, context) => {
    const mapped = publicError(error);
    const requestId = requestIdFromContext(context);

    try {
      logger.error({
        event: "api_request_failed",
        requestId,
        code: mapped.code,
        status: mapped.status,
        method: context.req.method,
        routeClass: routeClass(context.req.path),
      });
    } catch {
      // A logging outage must not replace the stable, scrubbed public error.
    }
    context.header("x-request-id", requestId);
    context.header("cache-control", "no-store");

    return context.json(
      {
        error: {
          code: mapped.code,
          message: mapped.message,
          requestId,
        },
      },
      mapped.status,
    );
  };
}

export const errorHandler = createErrorHandler();
