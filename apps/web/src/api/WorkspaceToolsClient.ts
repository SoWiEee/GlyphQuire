import {
  apiErrorEnvelopeSchema,
  assetCleanupRequestSchema,
  assetResponseSchema,
  backupVerificationQuerySchema,
  backupVerificationResponseSchema,
  canonicalUuidSchema,
  createShareLinkInputSchema,
  deadLetterQuerySchema,
  deadLetterReplayParamsSchema,
  deadLetterResponseSchema,
  exportFormatSchema,
  exportResultSchema,
  exportScopeSchema,
  idempotencyKeySchema,
  importJobResultSchema,
  maintenanceCapabilitiesResponseSchema,
  maintenanceJobMutationResponseSchema,
  maintenanceSearchRebuildRequestSchema,
  requestIdSchema,
  searchQuerySchema,
  searchResponseSchema,
  shareLinkResponseSchema,
  type ApiErrorCode,
  type AssetCleanupRequest,
  type AssetResponse,
  type BackupVerificationResponse,
  type CreateShareLinkInput,
  type DeadLetterResponse,
  type ExportFormat,
  type ExportResult,
  type ImportJobResult,
  type MaintenanceCapabilitiesResponse,
  type MaintenanceJobMutationResponse,
  type MaintenanceSearchRebuildRequest,
  type SearchQuery,
  type SearchResponse,
  type ShareLinkResponse,
} from "@glyphquire/api-contract";
import { z } from "zod";

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const CANONICAL_RELATIVE_API_BASE = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u;

export type WorkspaceToolsFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class WorkspaceToolsApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    readonly requestId: string,
  ) {
    super(`Workspace tools API request failed: ${code}`);
    this.name = "WorkspaceToolsApiError";
  }
}

export class WorkspaceToolsOfflineError extends Error {
  constructor() {
    super("Workspace tools request could not be completed");
    this.name = "WorkspaceToolsOfflineError";
  }
}

export class WorkspaceToolsValidationError extends Error {
  constructor(readonly boundary: "request" | "response") {
    super(`Invalid workspace tools ${boundary}`);
    this.name = "WorkspaceToolsValidationError";
  }
}

export class WorkspaceToolsClientConfigurationError extends Error {
  constructor() {
    super("Invalid same-origin workspace tools API base");
    this.name = "WorkspaceToolsClientConfigurationError";
  }
}

const browserFileSchema = z.custom<File>(
  (value) =>
    typeof File !== "undefined" &&
    value instanceof File &&
    value.name.length > 0 &&
    value.name.length <= 255,
  "Expected a bounded browser File",
);

const uploadAssetInputSchema = z
  .object({
    workspaceId: canonicalUuidSchema,
    file: browserFileSchema.refine(
      (file) => file.size > 0 && file.size <= MAX_ASSET_BYTES,
      "Asset size is out of range",
    ),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

const startImportInputSchema = z
  .object({
    workspaceId: canonicalUuidSchema,
    file: browserFileSchema.refine(
      (file) => file.size > 0 && file.size <= MAX_IMPORT_BYTES,
      "Import size is out of range",
    ),
    noteId: canonicalUuidSchema.optional(),
    baseRevision: z.number().int().positive().max(2_147_483_646).optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.noteId === undefined) !== (value.baseRevision === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.noteId === undefined ? "noteId" : "baseRevision"],
        message: "Existing-note imports require both noteId and baseRevision",
      });
    }
  });

const startExportInputSchema = z
  .object({
    scope: exportScopeSchema,
    format: exportFormatSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

const getExportOptionsSchema = z
  .object({ download: z.boolean().default(false) })
  .strict()
  .default({ download: false });

export interface UploadAssetInput {
  workspaceId: string;
  file: File;
  idempotencyKey?: string;
}

export interface StartImportInput {
  workspaceId: string;
  file: File;
  noteId?: string;
  baseRevision?: number;
  idempotencyKey?: string;
}

export interface StartExportInput {
  scope: z.input<typeof exportScopeSchema>;
  format: ExportFormat;
  idempotencyKey?: string;
}

export interface MaintenanceClient {
  getMaintenanceCapabilities(): Promise<MaintenanceCapabilitiesResponse>;
  startSearchRebuild(
    input: MaintenanceSearchRebuildRequest,
    idempotencyKey?: string,
  ): Promise<MaintenanceJobMutationResponse>;
  listDeadLetters(query?: z.input<typeof deadLetterQuerySchema>): Promise<DeadLetterResponse>;
  replayDeadLetter(
    deadLetterId: string,
    idempotencyKey?: string,
  ): Promise<MaintenanceJobMutationResponse>;
  runAssetCleanup(
    input: AssetCleanupRequest,
    idempotencyKey?: string,
  ): Promise<MaintenanceJobMutationResponse>;
  getBackupVerification(
    query?: z.input<typeof backupVerificationQuerySchema>,
  ): Promise<BackupVerificationResponse>;
}

export interface WorkspaceToolsClientOptions {
  /** Canonical root-relative prefix; defaults to the same-origin workspace tools API. */
  baseUrl?: string;
  fetchImpl?: WorkspaceToolsFetch;
  requestIdFactory?: () => string;
  idempotencyKeyFactory?: () => string;
}

interface JsonRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  form?: FormData;
  idempotencyKey?: string;
  expectedStatus?: number;
  empty?: boolean;
}

function parseRelativeApiBase(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_RELATIVE_API_BASE.test(value)) {
    throw new WorkspaceToolsClientConfigurationError();
  }
  if (
    value.split("/").some((segment) => segment === "." || segment === "..") ||
    /%(?:2e|2f|5c)/iu.test(value)
  ) {
    throw new WorkspaceToolsClientConfigurationError();
  }
  return value;
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function invalidResponse(): WorkspaceToolsValidationError {
  return new WorkspaceToolsValidationError("response");
}

function contentTypeIsJson(response: Response): boolean {
  return /^(?:application\/json|[^;,]+\+json)(?:\s*;|$)/iu.test(
    response.headers.get("content-type") ?? "",
  );
}

function sameOriginShareUrl(baseUrl: string, response: ShareLinkResponse): boolean {
  let parsed: URL;
  try {
    parsed = new URL(response.url);
  } catch {
    return false;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return false;
  }
  const browserOrigin = globalThis.location?.origin;
  if (browserOrigin && parsed.origin !== browserOrigin) return false;
  return parsed.pathname === `${baseUrl}/shared/${pathSegment(response.token)}`;
}

/**
 * Browser adapter for workspace tools. This is the only module that builds workspace tools
 * request URLs, and it never accepts an absolute API origin or bearer token.
 */
export class WorkspaceToolsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: WorkspaceToolsFetch;
  private readonly requestIdFactory: () => string;
  private readonly idempotencyKeyFactory: () => string;

  constructor(options: WorkspaceToolsClientOptions = {}) {
    this.baseUrl = parseRelativeApiBase(options.baseUrl ?? "/api/v1");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.requestIdFactory = options.requestIdFactory ?? (() => crypto.randomUUID());
    this.idempotencyKeyFactory = options.idempotencyKeyFactory ?? (() => crypto.randomUUID());
  }

  async uploadAsset(input: UploadAssetInput): Promise<AssetResponse> {
    const parsed = uploadAssetInputSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceToolsValidationError("request");
    const form = new FormData();
    form.set("file", parsed.data.file);
    const raw = await this.request(`/workspaces/${pathSegment(parsed.data.workspaceId)}/assets`, {
      method: "POST",
      form,
      idempotencyKey: parsed.data.idempotencyKey ?? this.idempotencyKey(),
      expectedStatus: 201,
    });
    const result = assetResponseSchema.safeParse(raw);
    if (
      !result.success ||
      result.data.workspaceId !== parsed.data.workspaceId ||
      result.data.deletedAt !== null
    ) {
      throw invalidResponse();
    }
    return result.data;
  }

  async search(input: SearchQuery): Promise<SearchResponse> {
    const parsed = searchQuerySchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceToolsValidationError("request");
    const query = new URLSearchParams({
      workspaceId: parsed.data.workspaceId,
      q: parsed.data.q,
      pageSize: String(parsed.data.pageSize),
      ranking: parsed.data.ranking,
    });
    if (parsed.data.cursor) query.set("cursor", parsed.data.cursor);
    const raw = await this.request(`/search?${query.toString()}`);
    const result = searchResponseSchema.safeParse(raw);
    if (
      !result.success ||
      result.data.items.some((item) => item.workspaceId !== parsed.data.workspaceId)
    ) {
      throw invalidResponse();
    }
    return result.data;
  }

  async startImport(input: StartImportInput): Promise<ImportJobResult> {
    const parsed = startImportInputSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceToolsValidationError("request");
    const form = new FormData();
    form.set("file", parsed.data.file);
    if (parsed.data.noteId) form.set("noteId", parsed.data.noteId);
    if (parsed.data.baseRevision !== undefined) {
      form.set("baseRevision", String(parsed.data.baseRevision));
    }
    const raw = await this.request(`/workspaces/${pathSegment(parsed.data.workspaceId)}/import`, {
      method: "POST",
      form,
      idempotencyKey: parsed.data.idempotencyKey ?? this.idempotencyKey(),
      expectedStatus: 202,
    });
    const result = importJobResultSchema.safeParse(raw);
    if (
      !result.success ||
      result.data.workspaceId !== parsed.data.workspaceId ||
      (parsed.data.noteId !== undefined && result.data.noteId !== parsed.data.noteId)
    ) {
      throw invalidResponse();
    }
    return result.data;
  }

  async getImport(importId: string): Promise<ImportJobResult> {
    const parsedId = canonicalUuidSchema.safeParse(importId);
    if (!parsedId.success) throw new WorkspaceToolsValidationError("request");
    const result = importJobResultSchema.safeParse(
      await this.request(`/imports/${pathSegment(parsedId.data)}`),
    );
    if (!result.success || result.data.id !== parsedId.data) throw invalidResponse();
    return result.data;
  }

  async startExport(input: StartExportInput): Promise<ExportResult> {
    const parsed = startExportInputSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceToolsValidationError("request");
    const path =
      parsed.data.scope.type === "workspace"
        ? `/workspaces/${pathSegment(parsed.data.scope.workspaceId)}/export`
        : `/notes/${pathSegment(parsed.data.scope.noteId)}/export`;
    const raw = await this.request(path, {
      method: "POST",
      body: { format: parsed.data.format },
      idempotencyKey: parsed.data.idempotencyKey ?? this.idempotencyKey(),
      expectedStatus: 202,
    });
    const result = exportResultSchema.safeParse(raw);
    if (!result.success || !this.exportIdentityMatches(parsed.data.scope, result.data)) {
      throw invalidResponse();
    }
    return result.data;
  }

  async getExport(exportId: string, options: { download?: boolean } = {}): Promise<ExportResult> {
    const parsedId = canonicalUuidSchema.safeParse(exportId);
    const parsedOptions = getExportOptionsSchema.safeParse(options);
    if (!parsedId.success || !parsedOptions.success) {
      throw new WorkspaceToolsValidationError("request");
    }
    const suffix = parsedOptions.data.download ? "/download" : "";
    const result = exportResultSchema.safeParse(
      await this.request(`/exports/${pathSegment(parsedId.data)}${suffix}`),
    );
    if (
      !result.success ||
      result.data.id !== parsedId.data ||
      (parsedOptions.data.download &&
        (result.data.status !== "completed" || result.data.downloadUrl === undefined))
    ) {
      throw invalidResponse();
    }
    return result.data;
  }

  async createShareLink(
    noteId: string,
    input: CreateShareLinkInput,
    idempotencyKey?: string,
  ): Promise<ShareLinkResponse> {
    const parsedId = canonicalUuidSchema.safeParse(noteId);
    const parsedInput = createShareLinkInputSchema.safeParse(input);
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey ?? this.idempotencyKey());
    if (!parsedId.success || !parsedInput.success || !parsedKey.success) {
      throw new WorkspaceToolsValidationError("request");
    }
    const result = shareLinkResponseSchema.safeParse(
      await this.request(`/notes/${pathSegment(parsedId.data)}/share-links`, {
        method: "POST",
        body: parsedInput.data,
        idempotencyKey: parsedKey.data,
        expectedStatus: 201,
      }),
    );
    if (
      !result.success ||
      result.data.noteId !== parsedId.data ||
      !sameOriginShareUrl(this.baseUrl, result.data)
    ) {
      throw invalidResponse();
    }
    return result.data;
  }

  async revokeShareLink(linkId: string): Promise<void> {
    const parsedId = canonicalUuidSchema.safeParse(linkId);
    if (!parsedId.success) throw new WorkspaceToolsValidationError("request");
    await this.request(`/share-links/${pathSegment(parsedId.data)}`, {
      method: "DELETE",
      expectedStatus: 204,
      empty: true,
    });
  }

  async getMaintenanceCapabilities(): Promise<MaintenanceCapabilitiesResponse> {
    const result = maintenanceCapabilitiesResponseSchema.safeParse(
      await this.request("/maintenance/capabilities"),
    );
    if (!result.success) throw invalidResponse();
    return result.data;
  }

  async startSearchRebuild(
    input: MaintenanceSearchRebuildRequest,
    idempotencyKey?: string,
  ): Promise<MaintenanceJobMutationResponse> {
    const parsed = maintenanceSearchRebuildRequestSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceToolsValidationError("request");
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey ?? this.idempotencyKey());
    if (!parsedKey.success) throw new WorkspaceToolsValidationError("request");
    const result = maintenanceJobMutationResponseSchema.safeParse(
      await this.request("/maintenance/search-rebuild", {
        method: "POST",
        body: parsed.data,
        idempotencyKey: parsedKey.data,
        expectedStatus: 202,
      }),
    );
    if (!result.success) throw invalidResponse();
    return result.data;
  }

  async listDeadLetters(
    query: z.input<typeof deadLetterQuerySchema> = {},
  ): Promise<DeadLetterResponse> {
    const parsed = deadLetterQuerySchema.safeParse(query);
    if (!parsed.success) throw new WorkspaceToolsValidationError("request");
    const queryString = new URLSearchParams({ pageSize: String(parsed.data.pageSize) });
    if (parsed.data.cursor) queryString.set("cursor", parsed.data.cursor);
    const result = deadLetterResponseSchema.safeParse(
      await this.request(`/maintenance/dead-letters?${queryString.toString()}`),
    );
    if (!result.success) throw invalidResponse();
    return result.data;
  }

  async replayDeadLetter(
    deadLetterId: string,
    idempotencyKey?: string,
  ): Promise<MaintenanceJobMutationResponse> {
    const parsedId = deadLetterReplayParamsSchema.safeParse({ id: deadLetterId });
    if (!parsedId.success) throw new WorkspaceToolsValidationError("request");
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey ?? this.idempotencyKey());
    if (!parsedKey.success) throw new WorkspaceToolsValidationError("request");
    const result = maintenanceJobMutationResponseSchema.safeParse(
      await this.request(`/maintenance/dead-letters/${pathSegment(parsedId.data.id)}/replay`, {
        method: "POST",
        idempotencyKey: parsedKey.data,
        expectedStatus: 202,
      }),
    );
    if (!result.success) throw invalidResponse();
    return result.data;
  }

  async runAssetCleanup(
    input: AssetCleanupRequest,
    idempotencyKey?: string,
  ): Promise<MaintenanceJobMutationResponse> {
    const parsed = assetCleanupRequestSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceToolsValidationError("request");
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey ?? this.idempotencyKey());
    if (!parsedKey.success) throw new WorkspaceToolsValidationError("request");
    const result = maintenanceJobMutationResponseSchema.safeParse(
      await this.request("/maintenance/asset-cleanup", {
        method: "POST",
        body: parsed.data,
        idempotencyKey: parsedKey.data,
        expectedStatus: 202,
      }),
    );
    if (!result.success) throw invalidResponse();
    return result.data;
  }

  async getBackupVerification(
    query: z.input<typeof backupVerificationQuerySchema> = {},
  ): Promise<BackupVerificationResponse> {
    const parsed = backupVerificationQuerySchema.safeParse(query);
    if (!parsed.success) throw new WorkspaceToolsValidationError("request");
    const queryString = new URLSearchParams({ pageSize: String(parsed.data.pageSize) });
    if (parsed.data.cursor) queryString.set("cursor", parsed.data.cursor);
    const result = backupVerificationResponseSchema.safeParse(
      await this.request(`/maintenance/backup-verification?${queryString.toString()}`),
    );
    if (!result.success) throw invalidResponse();
    return result.data;
  }

  private exportIdentityMatches(
    requested: z.output<typeof exportScopeSchema>,
    response: ExportResult,
  ): boolean {
    if (requested.type === "workspace") {
      return (
        response.workspaceId === requested.workspaceId &&
        response.scope.type === "workspace" &&
        response.scope.workspaceId === requested.workspaceId
      );
    }
    return (
      response.workspaceId === requested.workspaceId &&
      response.scope.type === "note" &&
      response.scope.workspaceId === requested.workspaceId &&
      response.scope.noteId === requested.noteId
    );
  }

  private idempotencyKey(): string {
    const parsed = idempotencyKeySchema.safeParse(this.idempotencyKeyFactory());
    if (!parsed.success) throw new WorkspaceToolsClientConfigurationError();
    return parsed.data;
  }

  private requestId(): string {
    const parsed = requestIdSchema.safeParse(this.requestIdFactory());
    if (!parsed.success) throw new WorkspaceToolsClientConfigurationError();
    return parsed.data;
  }

  private async request(path: string, options: JsonRequestOptions = {}): Promise<unknown> {
    const headers = new Headers({ accept: "application/json", "x-request-id": this.requestId() });
    let body: BodyInit | undefined;
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
    if (options.form) body = options.form;
    else if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "same-origin",
      });
    } catch {
      throw new WorkspaceToolsOfflineError();
    }

    if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
      return this.throwForError(response);
    }
    if (!response.ok) return this.throwForError(response);
    if (options.empty) {
      if (response.status !== 204) throw invalidResponse();
      return undefined;
    }
    if (!contentTypeIsJson(response)) throw invalidResponse();
    try {
      return await response.json();
    } catch {
      throw invalidResponse();
    }
  }

  private async throwForError(response: Response): Promise<never> {
    let raw: unknown;
    try {
      raw = contentTypeIsJson(response) ? await response.json() : undefined;
    } catch {
      raw = undefined;
    }
    const parsed = apiErrorEnvelopeSchema.safeParse(raw);
    if (parsed.success) {
      throw new WorkspaceToolsApiError(
        parsed.data.error.code,
        response.status,
        parsed.data.error.requestId,
      );
    }
    throw new WorkspaceToolsApiError("SERVICE_UNAVAILABLE", response.status, "unknown");
  }
}
