import { BroadcastTabChannel, noteScopeSchema, sameNoteScope } from "./TabChannel.js";
import type { NoteScope, TabChannel, TabEnvelope } from "./TabChannel.js";

export interface LockRequestOptions {
  mode: "exclusive";
  ifAvailable?: boolean;
  signal?: AbortSignal;
}

/** The subset of navigator.locks used by this module. */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: LockRequestOptions,
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
}

function defaultLockManager(): LockManagerLike {
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error("The Web Locks API is not available in this environment");
  }
  return navigator.locks;
}

export function noteLockName(scope: NoteScope): string {
  const validated = noteScopeSchema.parse(scope);
  return `glyphquire-note-lock:${validated.userId}:${validated.workspaceId}:${validated.noteId}`;
}

export interface NoteLockOptions {
  lockManager?: LockManagerLike;
  tabChannel?: TabChannel;
  channelPrefix?: string;
  tabId?: string;
  /** Maximum wait for the targeted owner to release after a takeover request. */
  takeoverWaitMs?: number;
  /** Maximum wait for the current owner to answer an owner query. */
  ownerDiscoveryWaitMs?: number;
}

const DEFAULT_TAKEOVER_WAIT_MS = 2_000;
const DEFAULT_OWNER_DISCOVERY_WAIT_MS = 100;

/**
 * Advisory one-writer coordination for exactly one user/workspace/note scope.
 * The server's revision CAS remains the authority if Web Locks or a same-origin
 * channel is unavailable, delayed, or manipulated.
 */
export class NoteLock {
  readonly scope: NoteScope;
  private readonly lockManager: LockManagerLike;
  private readonly tabChannel: TabChannel;
  private readonly takeoverWaitMs: number;
  private readonly ownerDiscoveryWaitMs: number;
  private readonly lockName: string;
  private readonly unsubscribe: () => void;
  private readonly ownershipListeners = new Set<(owned: boolean) => void>();
  private releaseHeldLock: (() => void) | undefined;
  private activeOwnerTabId: string | undefined;
  private disposed = false;

  constructor(scope: NoteScope, options: NoteLockOptions = {}) {
    this.scope = noteScopeSchema.parse(scope);
    this.lockManager = options.lockManager ?? defaultLockManager();
    this.tabChannel =
      options.tabChannel ??
      new BroadcastTabChannel(this.scope, {
        tabId: options.tabId,
        channelPrefix: options.channelPrefix,
      });
    if (!sameNoteScope(this.scope, this.tabChannel.scope)) {
      throw new Error("TabChannel scope does not match NoteLock scope");
    }
    this.takeoverWaitMs = options.takeoverWaitMs ?? DEFAULT_TAKEOVER_WAIT_MS;
    this.ownerDiscoveryWaitMs = options.ownerDiscoveryWaitMs ?? DEFAULT_OWNER_DISCOVERY_WAIT_MS;
    this.lockName = noteLockName(this.scope);
    this.unsubscribe = this.tabChannel.subscribe((envelope) => this.handleTabMessage(envelope));
  }

  /** Non-blocking: becomes the writer immediately if free, else stays read-only. */
  async acquire(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.releaseHeldLock) return true;

    return new Promise<boolean>((resolveOuter, rejectOuter) => {
      this.lockManager
        .request(this.lockName, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock || this.disposed) {
            resolveOuter(false);
            if (!lock) this.tabChannel.postOwnerQuery();
            return;
          }

          const held = new Promise<void>((release) => {
            this.releaseHeldLock = release;
          });
          this.activeOwnerTabId = this.tabChannel.tabId;
          this.notifyOwnership(true);
          this.tabChannel.postLockAcquired();
          resolveOuter(true);
          await held;
        })
        .catch(rejectOuter);
    });
  }

  /**
   * Requests release from the owner that was observed before this request.
   * Targeting that tab id prevents a delayed second request from making the
   * newly acquired owner release, keeping simultaneous takeovers deterministic:
   * exactly one requester can own the underlying exclusive Web Lock.
   */
  async requestTakeover(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.releaseHeldLock) return true;

    const ownerTabId = this.activeOwnerTabId ?? (await this.discoverOwner());
    if (!ownerTabId) return this.acquire();

    const released = this.waitForRelease(ownerTabId);
    this.tabChannel.postTakeoverRequest(ownerTabId);
    await released;
    await Promise.resolve();
    return this.acquire();
  }

  isOwner(): boolean {
    return this.releaseHeldLock !== undefined;
  }

  subscribeOwnership(listener: (owned: boolean) => void): () => void {
    this.ownershipListeners.add(listener);
    return () => this.ownershipListeners.delete(listener);
  }

  /** Voluntarily gives up write ownership. Safe to call when not held. */
  release(): void {
    const release = this.releaseHeldLock;
    if (!release) return;
    this.releaseHeldLock = undefined;
    this.activeOwnerTabId = undefined;
    release();
    this.tabChannel.postLockReleased(this.tabChannel.tabId);
    this.notifyOwnership(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.unsubscribe();
    this.tabChannel.close();
    this.ownershipListeners.clear();
  }

  private handleTabMessage(envelope: TabEnvelope): void {
    switch (envelope.payload.kind) {
      case "owner-query":
        if (this.isOwner()) this.tabChannel.postLockAcquired();
        return;
      case "lock-acquired":
        this.activeOwnerTabId = envelope.tabId;
        return;
      case "takeover-request":
        if (envelope.payload.targetTabId === this.tabChannel.tabId && this.isOwner()) {
          this.release();
        }
        return;
      case "lock-released":
        if (this.activeOwnerTabId === envelope.payload.ownerTabId) {
          this.activeOwnerTabId = undefined;
        }
        return;
      case "logout":
        // Browser session lifecycle owns logout clearing and locking.
        return;
    }
  }

  private discoverOwner(): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ownerTabId?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(ownerTabId);
      };
      const unsubscribe = this.tabChannel.subscribe((envelope) => {
        if (envelope.payload.kind === "lock-acquired") finish(envelope.tabId);
      });
      const timer = setTimeout(() => finish(this.activeOwnerTabId), this.ownerDiscoveryWaitMs);
      this.tabChannel.postOwnerQuery();
    });
  }

  private waitForRelease(ownerTabId: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const unsubscribe = this.tabChannel.subscribe((envelope) => {
        if (
          envelope.payload.kind === "lock-released" &&
          envelope.payload.ownerTabId === ownerTabId
        ) {
          finish();
        }
      });
      const timer = setTimeout(finish, this.takeoverWaitMs);
    });
  }

  private notifyOwnership(owned: boolean): void {
    for (const listener of this.ownershipListeners) listener(owned);
  }
}
