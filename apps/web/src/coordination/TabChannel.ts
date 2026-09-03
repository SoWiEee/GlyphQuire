import { canonicalUuidSchema } from "@glyphquire/api-contract";
import { z } from "zod";
import { coordinationUserIdSchema } from "./userIdSchema.js";

/** The complete tenant/note identity for one advisory cross-tab channel. */
export const noteScopeSchema = z
  .object({
    userId: coordinationUserIdSchema,
    workspaceId: canonicalUuidSchema,
    noteId: canonicalUuidSchema,
  })
  .strict();

export type NoteScope = z.infer<typeof noteScopeSchema>;

/** The subset of BroadcastChannel used by this module. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

const DEFAULT_CHANNEL_PREFIX = "glyphquire-notes";

const tabPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner-query") }).strict(),
  z.object({ kind: z.literal("lock-acquired") }).strict(),
  z.object({ kind: z.literal("takeover-request"), targetTabId: canonicalUuidSchema }).strict(),
  z.object({ kind: z.literal("lock-released"), ownerTabId: canonicalUuidSchema }).strict(),
  z.object({ kind: z.literal("logout") }).strict(),
]);

const tabEnvelopeSchema = z
  .object({
    tabId: canonicalUuidSchema,
    scope: noteScopeSchema,
    payload: tabPayloadSchema,
  })
  .strict();

export type TabChannelPayload = z.infer<typeof tabPayloadSchema>;
export type TabEnvelope = z.infer<typeof tabEnvelopeSchema>;

export function sameNoteScope(left: NoteScope, right: NoteScope): boolean {
  return (
    left.userId === right.userId &&
    left.workspaceId === right.workspaceId &&
    left.noteId === right.noteId
  );
}

/** A deterministic name that prevents identities or notes from sharing advisory messages. */
export function tabChannelName(scope: NoteScope, prefix = DEFAULT_CHANNEL_PREFIX): string {
  const validated = noteScopeSchema.parse(scope);
  return `${prefix}:${validated.userId}:${validated.workspaceId}:${validated.noteId}`;
}

export interface TabChannel {
  readonly tabId: string;
  readonly scope: NoteScope;
  postOwnerQuery(): void;
  postLockAcquired(): void;
  postTakeoverRequest(targetTabId: string): void;
  postLockReleased(ownerTabId: string): void;
  postLogout(): void;
  subscribe(listener: (envelope: TabEnvelope) => void): () => void;
  close(): void;
}

export interface TabChannelOptions {
  tabId?: string;
  channelFactory?: (name: string) => BroadcastChannelLike;
  /** Tests may use an isolated prefix; the validated scope is always appended. */
  channelPrefix?: string;
}

function defaultChannelFactory(name: string): BroadcastChannelLike {
  return new BroadcastChannel(name);
}

function generateTabId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== "function") {
    throw new Error("Cryptographically random UUID generation is unavailable");
  }
  return canonicalUuidSchema.parse(randomUUID.call(globalThis.crypto));
}

/**
 * Validated, note-scoped BroadcastChannel transport. Same-origin messages are
 * advisory only: this prevents accidental/cross-account mixing, while the
 * server revision CAS remains authoritative against compromised tabs.
 */
export class BroadcastTabChannel implements TabChannel {
  readonly tabId: string;
  readonly scope: NoteScope;
  private readonly channel: BroadcastChannelLike;
  private readonly listeners = new Set<(envelope: TabEnvelope) => void>();
  private closed = false;
  private readonly handleMessage = (event: MessageEvent): void => {
    const parsed = tabEnvelopeSchema.safeParse(event.data);
    if (!parsed.success) return;
    if (parsed.data.tabId === this.tabId) return;
    if (!sameNoteScope(parsed.data.scope, this.scope)) return;
    for (const listener of this.listeners) listener(parsed.data);
  };

  constructor(scope: NoteScope, options: TabChannelOptions = {}) {
    this.scope = noteScopeSchema.parse(scope);
    this.tabId = canonicalUuidSchema.parse(options.tabId ?? generateTabId());
    const factory = options.channelFactory ?? defaultChannelFactory;
    this.channel = factory(tabChannelName(this.scope, options.channelPrefix));
    this.channel.addEventListener("message", this.handleMessage);
  }

  postOwnerQuery(): void {
    this.post({ kind: "owner-query" });
  }

  postLockAcquired(): void {
    this.post({ kind: "lock-acquired" });
  }

  postTakeoverRequest(targetTabId: string): void {
    this.post({
      kind: "takeover-request",
      targetTabId: canonicalUuidSchema.parse(targetTabId),
    });
  }

  postLockReleased(ownerTabId: string): void {
    this.post({ kind: "lock-released", ownerTabId: canonicalUuidSchema.parse(ownerTabId) });
  }

  postLogout(): void {
    this.post({ kind: "logout" });
  }

  subscribe(listener: (envelope: TabEnvelope) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener("message", this.handleMessage);
    this.channel.close();
    this.listeners.clear();
  }

  private post(payload: TabChannelPayload): void {
    if (this.closed) return;
    const envelope = tabEnvelopeSchema.parse({ tabId: this.tabId, scope: this.scope, payload });
    this.channel.postMessage(envelope);
  }
}
