import { meResultSchema, type MeResult } from "@glyphquire/api-contract";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MeGateway {
  fetchMe(): Promise<MeResult>;
}

/** The caller has no valid session (server returns 401/404 before the handler). */
export class MeUnauthorizedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "MeUnauthorizedError";
  }
}

/** Any other failure fetching or validating /api/v1/me. */
export class MeRequestError extends Error {
  constructor(message = "Failed to load account identity") {
    super(message);
    this.name = "MeRequestError";
  }
}

export class MeClient implements MeGateway {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis), baseUrl = "") {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
  }

  async fetchMe(): Promise<MeResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1/me`, {
        method: "GET",
        credentials: "same-origin",
      });
    } catch (cause) {
      throw new MeRequestError(cause instanceof Error ? cause.message : undefined);
    }
    if (response.status === 401 || response.status === 404) throw new MeUnauthorizedError();
    if (!response.ok) throw new MeRequestError();
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MeRequestError();
    }
    const parsed = meResultSchema.safeParse(payload);
    if (!parsed.success) throw new MeRequestError();
    return parsed.data;
  }
}
