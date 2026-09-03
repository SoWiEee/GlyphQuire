import { describe, expect, it, vi } from "vitest";
import { BroadcastTabChannel, noteScopeSchema, tabChannelName } from "./TabChannel.js";
import type { BroadcastChannelLike, NoteScope } from "./TabChannel.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const TAB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const SCOPE: NoteScope = {
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  noteId: NOTE_ID,
};

class RecordingBroadcastChannel implements BroadcastChannelLike {
  readonly posted: unknown[] = [];
  private listener: ((event: MessageEvent) => void) | undefined;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  close(): void {}

  emit(data: unknown): void {
    this.listener?.({ data } as MessageEvent);
  }
}

describe("BroadcastTabChannel", () => {
  it("derives the channel name from canonical user, workspace, and note identities", () => {
    const rawChannel = new RecordingBroadcastChannel();
    const factory = vi.fn(() => rawChannel);

    const channel = new BroadcastTabChannel(SCOPE, { tabId: TAB_A, channelFactory: factory });

    expect(factory).toHaveBeenCalledWith(`glyphquire-notes:${USER_ID}:${WORKSPACE_ID}:${NOTE_ID}`);
    expect(tabChannelName(SCOPE)).toBe(`glyphquire-notes:${USER_ID}:${WORKSPACE_ID}:${NOTE_ID}`);
    channel.close();
  });

  it("includes the complete validated scope on every outbound message", () => {
    const rawChannel = new RecordingBroadcastChannel();
    const channel = new BroadcastTabChannel(SCOPE, {
      tabId: TAB_A,
      channelFactory: () => rawChannel,
    });

    channel.postLogout();

    expect(rawChannel.posted).toEqual([
      { tabId: TAB_A, scope: SCOPE, payload: { kind: "logout" } },
    ]);
    channel.close();
  });

  it("rejects forged takeover and logout envelopes whose identity scope does not match", () => {
    const rawChannel = new RecordingBroadcastChannel();
    const channel = new BroadcastTabChannel(SCOPE, {
      tabId: TAB_A,
      channelFactory: () => rawChannel,
    });
    const listener = vi.fn();
    channel.subscribe(listener);

    rawChannel.emit({
      tabId: TAB_B,
      scope: { ...SCOPE, userId: OTHER_USER_ID },
      payload: { kind: "logout" },
    });
    rawChannel.emit({
      tabId: TAB_B,
      scope: { ...SCOPE, noteId: OTHER_USER_ID },
      payload: { kind: "takeover-request", targetTabId: TAB_A },
    });
    rawChannel.emit({
      tabId: "forged-tab",
      scope: SCOPE,
      payload: { kind: "logout" },
    });

    expect(listener).not.toHaveBeenCalled();

    rawChannel.emit({ tabId: TAB_B, scope: SCOPE, payload: { kind: "logout" } });
    expect(listener).toHaveBeenCalledOnce();
    channel.close();
  });

  it("accepts an opaque, non-UUID userId (real better-auth ids are not UUIDs)", () => {
    const opaqueScope = { ...SCOPE, userId: "usr_2N4kQb8fVxErq7wZ" };
    expect(() => noteScopeSchema.parse(opaqueScope)).not.toThrow();
  });

  it("still rejects a userId containing a colon", () => {
    const badScope = { ...SCOPE, userId: "evil:user" };
    expect(() => noteScopeSchema.parse(badScope)).toThrow();
  });
});
