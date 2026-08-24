import { canonicalUuidSchema } from "@glyphquire/api-contract";
import { z } from "zod";
import { BroadcastTabChannel, noteScopeSchema, sameNoteScope } from "./TabChannel.js";
import type { NoteScope, TabChannel, TabEnvelope } from "./TabChannel.js";
import type { DraftStore } from "../persistence/DraftStore.js";

export const SESSION_CONTROL_NOTE_ID = "00000000-0000-4000-8000-000000000000";

export const liveBrowserSessionSchema = z
  .object({
    userId: canonicalUuidSchema,
    expiresAt: z.number().int().safe().positive(),
    workspaceIds: z
      .array(canonicalUuidSchema)
      .min(1)
      .max(1_000)
      .superRefine((workspaceIds, context) => {
        if (new Set(workspaceIds).size !== workspaceIds.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Workspace authorizations must be unique",
          });
        }
      }),
  })
  .strict();

export type LiveBrowserSession = z.infer<typeof liveBrowserSessionSchema>;

export class SessionAuthorizationError extends Error {
  constructor() {
    super("A live authorized browser session is required");
    this.name = "SessionAuthorizationError";
  }
}

export interface SessionClock {
  now(): number;
  setTimeout?(handler: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

export type SessionTabChannelFactory = (scope: NoteScope) => TabChannel;

export interface SessionLifecycleCoordinatorOptions {
  /** Untrusted normalized session data from the authenticated session/workspace adapters. */
  initialSession: unknown;
  draftStore: Pick<DraftStore, "clearForUser">;
  clock?: SessionClock;
  channelFactory?: SessionTabChannelFactory;
}

export interface EditorSessionLifecycle {
  authorizeEditor(scope: NoteScope): Promise<void>;
  /** Synchronous guard for every write-sensitive browser action. */
  assertEditorAuthorized(scope: NoteScope): void;
  registerEditor(scope: NoteScope, lockAndClear: () => Promise<void>): () => void;
}

interface RegisteredEditor {
  readonly scope: NoteScope;
  readonly lockAndClear: () => Promise<void>;
}

interface ControlChannel {
  readonly scope: NoteScope;
  readonly channel: TabChannel;
  readonly unsubscribe: () => void;
}

const systemClock: Required<SessionClock> = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function defaultChannelFactory(scope: NoteScope): TabChannel {
  return new BroadcastTabChannel(scope);
}

/**
 * Owns browser-local account transitions. It invalidates writers, clears the
 * affected user's drafts, and broadcasts a scoped logout before a replacement
 * account can authorize draft access. Network logout is deliberately outside
 * that local critical path, so a rejection cannot strand sensitive drafts.
 */
export class BrowserSessionLifecycleCoordinator implements EditorSessionLifecycle {
  private readonly draftStore: Pick<DraftStore, "clearForUser">;
  private readonly clock: SessionClock;
  private readonly setSessionTimeout: (handler: () => void, ms: number) => number;
  private readonly clearSessionTimeout: (id: number) => void;
  private readonly channelFactory: SessionTabChannelFactory;
  private readonly editors = new Map<symbol, RegisteredEditor>();
  private readonly controlChannels: ControlChannel[] = [];
  private readonly endedUsers = new Set<string>();
  private currentSession: LiveBrowserSession | undefined;
  private transitionTail: Promise<void> = Promise.resolve();
  private expiryTimerId: number | undefined;
  private disposed = false;

  constructor(options: SessionLifecycleCoordinatorOptions) {
    this.draftStore = options.draftStore;
    this.clock = options.clock ?? systemClock;
    const customSetSessionTimeout = options.clock?.setTimeout?.bind(options.clock);
    const customClearSessionTimeout = options.clock?.clearTimeout?.bind(options.clock);
    this.setSessionTimeout =
      customSetSessionTimeout && customClearSessionTimeout
        ? customSetSessionTimeout
        : systemClock.setTimeout;
    this.clearSessionTimeout =
      customSetSessionTimeout && customClearSessionTimeout
        ? customClearSessionTimeout
        : systemClock.clearTimeout;
    this.channelFactory = options.channelFactory ?? defaultChannelFactory;
    this.installSession(liveBrowserSessionSchema.parse(options.initialSession));
  }

  async authorizeEditor(scope: NoteScope): Promise<void> {
    const validatedScope = noteScopeSchema.parse(scope);
    await this.transitionTail;
    this.assertAuthorized(validatedScope);
  }

  assertEditorAuthorized(scope: NoteScope): void {
    this.assertAuthorized(noteScopeSchema.parse(scope));
  }

  registerEditor(scope: NoteScope, lockAndClear: () => Promise<void>): () => void {
    const validatedScope = noteScopeSchema.parse(scope);
    this.assertAuthorized(validatedScope);
    const token = Symbol("editor-session");
    this.editors.set(token, { scope: validatedScope, lockAndClear });
    return () => this.editors.delete(token);
  }

  /**
   * Ends the local session before awaiting the server. Both local and network
   * failures are reported, but neither prevents the other side from running.
   */
  async logout(networkLogout: () => Promise<void>): Promise<void> {
    const userId = this.currentSession?.userId;
    let localFailure: unknown;
    if (userId) {
      try {
        await this.enqueueTransition(() => this.endUserLocally(userId));
      } catch (error) {
        localFailure = error;
      }
    }

    let networkFailure: unknown;
    try {
      await networkLogout();
    } catch (error) {
      networkFailure = error;
    }

    if (localFailure && networkFailure) {
      throw new AggregateError(
        [localFailure, networkFailure],
        "Local and network logout both failed",
      );
    }
    if (localFailure) throw localFailure;
    if (networkFailure) throw networkFailure;
  }

  /** Atomically clears the prior identity before making the replacement visible. */
  async switchAccount(nextSession: unknown): Promise<void> {
    const validatedNext = liveBrowserSessionSchema.parse(nextSession);
    await this.enqueueTransition(async () => {
      const previous = this.currentSession;
      if (previous && previous.userId !== validatedNext.userId) {
        await this.endUserLocally(previous.userId);
      } else {
        await this.revokeEditorsUnauthorizedBy(validatedNext);
        this.clearExpiryTimer();
        this.closeControlChannels();
      }
      this.installSession(validatedNext);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearExpiryTimer();
    this.closeControlChannels();
    this.editors.clear();
    this.currentSession = undefined;
  }

  private assertAuthorized(scope: NoteScope): void {
    const session = this.currentSession;
    if (
      this.disposed ||
      !session ||
      session.expiresAt <= this.clock.now() ||
      session.userId !== scope.userId ||
      !session.workspaceIds.includes(scope.workspaceId)
    ) {
      throw new SessionAuthorizationError();
    }
  }

  private installSession(session: LiveBrowserSession): void {
    if (this.disposed) throw new SessionAuthorizationError();
    this.currentSession = session;
    this.endedUsers.delete(session.userId);
    this.openControlChannels(session);
    this.scheduleExpiry(session);
  }

  private openControlChannels(session: LiveBrowserSession): void {
    for (const workspaceId of session.workspaceIds) {
      const scope = noteScopeSchema.parse({
        userId: session.userId,
        workspaceId,
        noteId: SESSION_CONTROL_NOTE_ID,
      });
      const channel = this.channelFactory(scope);
      if (!sameNoteScope(channel.scope, scope)) {
        channel.close();
        throw new Error("Session control channel scope mismatch");
      }
      const unsubscribe = channel.subscribe((envelope) => this.handleControlMessage(envelope));
      this.controlChannels.push({ scope, channel, unsubscribe });
    }
  }

  private handleControlMessage(envelope: TabEnvelope): void {
    if (envelope.payload.kind !== "logout") return;
    const session = this.currentSession;
    if (
      !session ||
      envelope.scope.userId !== session.userId ||
      !session.workspaceIds.includes(envelope.scope.workspaceId) ||
      envelope.scope.noteId !== SESSION_CONTROL_NOTE_ID
    ) {
      return;
    }
    void this.enqueueTransition(() => this.endUserLocally(session.userId)).catch(() => undefined);
  }

  private async endUserLocally(userId: string): Promise<void> {
    if (this.endedUsers.has(userId)) return;
    const hasMatchingState =
      this.currentSession?.userId === userId ||
      [...this.editors.values()].some((editor) => editor.scope.userId === userId);
    if (!hasMatchingState) return;

    this.endedUsers.add(userId);
    if (this.currentSession?.userId === userId) {
      this.currentSession = undefined;
      this.clearExpiryTimer();
    }

    const matchingEditors = [...this.editors.values()].filter(
      (editor) => editor.scope.userId === userId,
    );
    const lockResults = await Promise.allSettled(
      matchingEditors.map((editor) => editor.lockAndClear()),
    );

    const matchingChannels = this.controlChannels.filter((entry) => entry.scope.userId === userId);
    const localResults = await Promise.allSettled([
      this.draftStore.clearForUser(userId),
      ...matchingChannels.map(async (entry) => entry.channel.postLogout()),
    ]);

    // Let BroadcastChannel enqueue delivery before old-account channels close.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.closeControlChannelsForUser(userId);

    const failures = [...lockResults, ...localResults]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Local session clearing failed");
    }
  }

  private enqueueTransition(operation: () => Promise<void>): Promise<void> {
    const result = this.transitionTail.then(operation, operation);
    this.transitionTail = result.catch(() => undefined);
    return result;
  }

  private scheduleExpiry(session: LiveBrowserSession): void {
    this.clearExpiryTimer();
    const delay = Math.min(Math.max(0, session.expiresAt - this.clock.now()), MAX_TIMER_DELAY_MS);
    this.expiryTimerId = this.setSessionTimeout(() => {
      this.expiryTimerId = undefined;
      void this.enqueueTransition(() => this.expireSession(session)).catch(() => undefined);
    }, delay);
  }

  private async expireSession(expected: LiveBrowserSession): Promise<void> {
    if (this.currentSession !== expected) return;
    if (this.clock.now() < expected.expiresAt) {
      this.scheduleExpiry(expected);
      return;
    }

    this.currentSession = undefined;
    this.closeControlChannelsForUser(expected.userId);
    await this.revokeEditors((editor) => editor.scope.userId === expected.userId);
  }

  private async revokeEditorsUnauthorizedBy(nextSession: LiveBrowserSession): Promise<void> {
    await this.revokeEditors(
      (editor) =>
        editor.scope.userId !== nextSession.userId ||
        !nextSession.workspaceIds.includes(editor.scope.workspaceId),
    );
  }

  private async revokeEditors(predicate: (editor: RegisteredEditor) => boolean): Promise<void> {
    const results = await Promise.allSettled(
      [...this.editors.values()].filter(predicate).map((editor) => editor.lockAndClear()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Editor authorization revocation failed");
    }
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimerId === undefined) return;
    this.clearSessionTimeout(this.expiryTimerId);
    this.expiryTimerId = undefined;
  }

  private closeControlChannelsForUser(userId: string): void {
    for (let index = this.controlChannels.length - 1; index >= 0; index -= 1) {
      const entry = this.controlChannels[index];
      if (!entry || entry.scope.userId !== userId) continue;
      entry.unsubscribe();
      entry.channel.close();
      this.controlChannels.splice(index, 1);
    }
  }

  private closeControlChannels(): void {
    for (const entry of this.controlChannels.splice(0)) {
      entry.unsubscribe();
      entry.channel.close();
    }
  }
}
