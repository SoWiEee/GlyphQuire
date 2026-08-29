import {
  canonicalUuidSchema,
  markdownSchema,
  noteConflictSchema,
  revisionSchema,
} from "@glyphquire/api-contract";
import { NoteApiError, NoteConflictError, NoteOfflineError } from "../api/NoteClient.js";
import type { NoteConflict } from "@glyphquire/api-contract";

export type AutosaveStatus =
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "offline"
  | "error"
  | "conflict";

export interface AutosaveErrorInfo {
  readonly code: string;
  readonly message: string;
}

/** An immutable remote attempt identity and its exact recoverable payload. */
export interface AutosavePendingAttempt {
  readonly operationId: string;
  readonly baseRevision: number;
  readonly markdown: string;
}

export interface AutosaveState {
  readonly status: AutosaveStatus;
  readonly revision: number;
  readonly lastSavedAt: number | null;
  readonly lastError: AutosaveErrorInfo | null;
  readonly conflict: NoteConflict | null;
  readonly pending: AutosavePendingAttempt | null;
}

export interface AutosaveClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const systemClock: AutosaveClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export interface AutosaveSaveResult {
  readonly revision: number;
  readonly contentMarkdown: string;
}

export type AutosaveSaveFn = (input: {
  operationId: string;
  baseRevision: number;
  contentMarkdown: string;
}) => Promise<AutosaveSaveResult>;

export interface AutosaveDeps {
  initialRevision: number;
  save: AutosaveSaveFn;
  generateOperationId?: () => string;
  clock?: AutosaveClock;
  debounceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

interface MutableAttempt {
  operationId: string;
  baseRevision: number;
  markdown: string;
  /** Once sent, operation id and payload stay immutable across retries. */
  sent: boolean;
}

const DEFAULT_DEBOUNCE_MS = 1_500;
const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

function randomOperationId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== "function") {
    throw new Error("Cryptographically random UUID generation is unavailable");
  }
  return canonicalUuidSchema.parse(randomUUID.call(globalThis.crypto));
}

/**
 * Debounced, single-flight revision-CAS autosave. Each sent operation binds a
 * UUID to one immutable payload; edits made in flight receive a separate UUID
 * immediately so a crash can never persist a reused id with different content.
 */
export class AutosaveController {
  private readonly save: AutosaveSaveFn;
  private readonly generateOperationId: () => string;
  private readonly clock: AutosaveClock;
  private readonly debounceMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  private status: AutosaveStatus = "clean";
  private revision: number;
  private lastSavedAt: number | null = null;
  private lastError: AutosaveErrorInfo | null = null;
  private conflict: NoteConflict | null = null;
  private attempt: MutableAttempt | null = null;
  private queued: MutableAttempt | null = null;

  private debounceTimerId: number | undefined;
  private retryTimerId: number | undefined;
  private retryCount = 0;
  private attemptSeq = 0;
  private inFlight: Promise<void> | undefined;
  private dispatchAfterFlight = false;
  private paused = false;
  private disposed = false;
  private readonly listeners = new Set<(state: AutosaveState) => void>();

  constructor(deps: AutosaveDeps) {
    this.save = deps.save;
    this.generateOperationId = deps.generateOperationId ?? randomOperationId;
    this.clock = deps.clock ?? systemClock;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.retryBaseMs = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = deps.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.revision = revisionSchema.parse(deps.initialRevision);
  }

  getState(): AutosaveState {
    const pending = this.queued ?? this.attempt;
    return {
      status: this.status,
      revision: this.revision,
      lastSavedAt: this.lastSavedAt,
      lastError: this.lastError,
      conflict: this.conflict,
      pending: pending
        ? {
            operationId: pending.operationId,
            baseRevision: pending.baseRevision,
            markdown: pending.markdown,
          }
        : null,
    };
  }

  subscribe(listener: (state: AutosaveState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  edit(markdown: string): void {
    if (this.disposed) return;
    const validatedMarkdown = markdownSchema.parse(markdown);

    if (this.status === "conflict") {
      if (!this.queued) this.queued = this.newAttempt(validatedMarkdown, this.revision);
      else this.queued.markdown = validatedMarkdown;
      this.notify();
      return;
    }

    if (this.inFlight) {
      if (!this.queued) this.queued = this.newAttempt(validatedMarkdown, this.revision);
      else this.queued.markdown = validatedMarkdown;
      this.notify();
      return;
    }

    if (this.status === "offline" || this.status === "error") {
      this.attempt = this.newAttempt(validatedMarkdown, this.revision);
      this.queued = null;
      this.clearRetryTimer();
      this.retryCount = 0;
    } else if (this.attempt && !this.attempt.sent) {
      this.attempt.markdown = validatedMarkdown;
    } else {
      this.attempt = this.newAttempt(validatedMarkdown, this.revision);
    }

    this.status = "dirty";
    this.lastError = null;
    if (!this.paused) this.scheduleDebounce();
    this.notify();
  }

  recoverPendingAttempt(
    recovered: AutosavePendingAttempt,
    recoveredConflict: NoteConflict | null = null,
    mintFreshOperationId = false,
  ): void {
    if (this.disposed || this.status !== "clean") return;
    const attempt = {
      operationId: mintFreshOperationId
        ? canonicalUuidSchema.parse(this.generateOperationId())
        : canonicalUuidSchema.parse(recovered.operationId),
      baseRevision: revisionSchema.parse(recovered.baseRevision),
      markdown: markdownSchema.parse(recovered.markdown),
      sent: !mintFreshOperationId,
    };
    if (recoveredConflict) {
      const conflict = noteConflictSchema.parse(recoveredConflict);
      if (conflict.serverRevision !== attempt.baseRevision) {
        throw new Error("Recovered conflict revision does not match its draft");
      }
      this.attempt = null;
      this.queued = { ...attempt, sent: false };
      this.status = "conflict";
      this.conflict = conflict;
      this.notify();
      return;
    }
    this.attempt = attempt;
    this.status = "dirty";
    this.notify();
    if (!this.paused) this.startAttempt();
  }

  async saveNow(): Promise<void> {
    if (
      this.disposed ||
      this.paused ||
      this.inFlight ||
      this.status === "conflict" ||
      !this.attempt
    ) {
      return;
    }
    this.clearDebounceTimer();
    this.clearRetryTimer();
    this.retryCount = 0;
    this.startAttempt();
  }

  /** Reconnect hook: only failed attempts bypass their current backoff. */
  async retryNow(): Promise<void> {
    if (this.status !== "offline" && this.status !== "error") return;
    await this.saveNow();
  }

  /** Stops outgoing writes while retaining the latest recoverable attempt. */
  pause(): void {
    if (this.disposed || this.paused) return;
    this.paused = true;
    this.attemptSeq += 1;
    this.clearDebounceTimer();
    this.clearRetryTimer();
    this.dispatchAfterFlight = false;
    if (this.queued) {
      this.attempt = this.queued;
      this.queued = null;
    }
    if (this.attempt) this.status = "dirty";
    this.notify();
  }

  /** Resumes debounce after this tab regains its advisory write lock. */
  resume(): void {
    if (this.disposed || !this.paused) return;
    this.paused = false;
    if (this.attempt) {
      this.status = "dirty";
      this.scheduleDebounce();
      this.notify();
    }
  }

  /** Irreversibly scrubs drafts/conflict material after logout or account switch. */
  clearSensitiveState(): void {
    if (this.disposed) return;
    this.paused = true;
    this.attemptSeq += 1;
    this.clearDebounceTimer();
    this.clearRetryTimer();
    this.attempt = null;
    this.queued = null;
    this.conflict = null;
    this.lastError = null;
    this.lastSavedAt = null;
    this.status = "clean";
    this.dispatchAfterFlight = false;
    this.notify();
  }

  resolveConflict(serverRevision: number): void {
    if (this.disposed || this.status !== "conflict") return;
    const validatedRevision = revisionSchema.parse(serverRevision);
    if (validatedRevision < this.revision) {
      this.lastError = {
        code: "STALE_ACKNOWLEDGEMENT",
        message: "The supplied server revision would regress editor state",
      };
      this.notify();
      return;
    }

    this.revision = validatedRevision;
    this.conflict = null;
    this.lastError = null;
    if (this.queued) {
      this.attempt = { ...this.queued, baseRevision: validatedRevision, sent: false };
      this.queued = null;
      this.status = "dirty";
      if (!this.paused) this.scheduleDebounce();
    } else {
      this.attempt = null;
      this.status = "clean";
    }
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.attemptSeq += 1;
    this.clearDebounceTimer();
    this.clearRetryTimer();
    this.listeners.clear();
  }

  private newAttempt(markdown: string, baseRevision: number): MutableAttempt {
    return {
      operationId: canonicalUuidSchema.parse(this.generateOperationId()),
      baseRevision,
      markdown,
      sent: false,
    };
  }

  private scheduleDebounce(): void {
    this.clearDebounceTimer();
    this.debounceTimerId = this.clock.setTimeout(() => {
      this.debounceTimerId = undefined;
      this.startAttempt();
    }, this.debounceMs);
  }

  private startAttempt(): void {
    if (this.disposed || this.paused || !this.attempt) return;
    if (this.inFlight) {
      this.dispatchAfterFlight = true;
      return;
    }
    const active = this.attempt;
    active.sent = true;
    const promise = this.attemptSave(active);
    this.inFlight = promise;
    void promise.finally(() => {
      if (this.inFlight !== promise) return;
      this.inFlight = undefined;
      if (this.dispatchAfterFlight) {
        this.dispatchAfterFlight = false;
        this.startAttempt();
      }
    });
  }

  private async attemptSave(active: MutableAttempt): Promise<void> {
    this.clearRetryTimer();
    this.status = "saving";
    this.notify();
    const attemptToken = ++this.attemptSeq;

    try {
      const result = await this.save({
        operationId: active.operationId,
        baseRevision: active.baseRevision,
        contentMarkdown: active.markdown,
      });
      if (this.disposed || this.paused || attemptToken !== this.attemptSeq) return;
      this.onAttemptSucceeded(active, result);
    } catch (error) {
      if (this.disposed || this.paused || attemptToken !== this.attemptSeq) return;
      this.onAttemptFailed(active, error);
    }
  }

  private onAttemptSucceeded(active: MutableAttempt, result: AutosaveSaveResult): void {
    const acknowledgementIsCurrent =
      active === this.attempt &&
      active.baseRevision === this.revision &&
      result.revision === active.baseRevision + 1 &&
      result.contentMarkdown === active.markdown;
    if (!acknowledgementIsCurrent) {
      this.status = "error";
      this.lastError = {
        code: "STALE_ACKNOWLEDGEMENT",
        message: "The server acknowledgement did not match the active save",
      };
      this.notify();
      return;
    }

    this.revision = result.revision;
    this.lastSavedAt = this.clock.now();
    this.lastError = null;
    this.conflict = null;
    this.retryCount = 0;

    if (this.queued) {
      this.attempt = { ...this.queued, baseRevision: this.revision, sent: false };
      this.queued = null;
      this.status = "dirty";
      this.dispatchAfterFlight = true;
      this.notify();
      return;
    }

    this.attempt = null;
    this.status = "saved";
    this.notify();
  }

  private onAttemptFailed(active: MutableAttempt, error: unknown): void {
    if (error instanceof NoteConflictError) {
      const localMarkdown = this.queued?.markdown ?? active.markdown;
      this.attempt = null;
      this.queued = this.newAttempt(localMarkdown, error.conflict.serverRevision);
      this.status = "conflict";
      this.conflict = error.conflict;
      this.lastError = null;
      this.notify();
      return;
    }

    if (this.queued) {
      this.attempt = { ...this.queued, baseRevision: this.revision, sent: false };
      this.queued = null;
    }

    if (error instanceof NoteOfflineError) {
      this.status = "offline";
      this.lastError = { code: "OFFLINE", message: error.message };
    } else if (error instanceof NoteApiError) {
      this.status = "error";
      this.lastError = { code: error.code, message: error.message };
    } else {
      this.status = "error";
      this.lastError = {
        code: "UNKNOWN",
        message: error instanceof Error ? error.message : "Unknown autosave error",
      };
    }
    this.notify();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.paused || !this.attempt) return;
    this.retryCount += 1;
    const delay = Math.min(this.retryBaseMs * 2 ** (this.retryCount - 1), this.retryMaxMs);
    this.retryTimerId = this.clock.setTimeout(() => {
      this.retryTimerId = undefined;
      this.startAttempt();
    }, delay);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimerId === undefined) return;
    this.clock.clearTimeout(this.debounceTimerId);
    this.debounceTimerId = undefined;
  }

  private clearRetryTimer(): void {
    if (this.retryTimerId === undefined) return;
    this.clock.clearTimeout(this.retryTimerId);
    this.retryTimerId = undefined;
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
