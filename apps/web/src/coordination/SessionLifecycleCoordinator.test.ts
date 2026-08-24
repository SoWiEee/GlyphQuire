import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BroadcastTabChannel } from "./TabChannel.js";
import {
  BrowserSessionLifecycleCoordinator,
  SessionAuthorizationError,
} from "./SessionLifecycleCoordinator.js";
import type { LiveBrowserSession } from "./SessionLifecycleCoordinator.js";
import type { NoteScope } from "./TabChannel.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_B = "99999999-9999-4999-8999-999999999999";
const NOTE_ID = "44444444-4444-4444-8444-444444444444";

function liveSession(overrides: Partial<LiveBrowserSession> = {}): LiveBrowserSession {
  return {
    userId: USER_A,
    expiresAt: 10_000,
    workspaceIds: [WORKSPACE_A],
    ...overrides,
  };
}

function scope(overrides: Partial<NoteScope> = {}): NoteScope {
  return {
    userId: USER_A,
    workspaceId: WORKSPACE_A,
    noteId: NOTE_ID,
    ...overrides,
  };
}

function isolatedChannelFactory() {
  const channelPrefix = `session-lifecycle-test-${randomUUID()}`;
  return (channelScope: NoteScope) =>
    new BroadcastTabChannel(channelScope, {
      tabId: randomUUID(),
      channelPrefix,
    });
}

class ManualSessionClock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; handler: () => void }>();

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(handler: () => void, delay: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delay, handler });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  advanceTo(target: number): void {
    this.current = target;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= target)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.handler();
    }
  }
}

describe("BrowserSessionLifecycleCoordinator", () => {
  it("accepts only a live matching user with explicit authorization for the target workspace", async () => {
    const clearForUser = vi.fn(async () => undefined);
    const valid = new BrowserSessionLifecycleCoordinator({
      initialSession: liveSession(),
      draftStore: { clearForUser },
      clock: { now: () => 1_000 },
      channelFactory: isolatedChannelFactory(),
    });

    await expect(valid.authorizeEditor(scope())).resolves.toBeUndefined();
    await expect(valid.authorizeEditor(scope({ userId: USER_B }))).rejects.toBeInstanceOf(
      SessionAuthorizationError,
    );
    await expect(valid.authorizeEditor(scope({ workspaceId: WORKSPACE_B }))).rejects.toBeInstanceOf(
      SessionAuthorizationError,
    );
    valid.dispose();

    const expired = new BrowserSessionLifecycleCoordinator({
      initialSession: liveSession({ expiresAt: 1_000 }),
      draftStore: { clearForUser },
      clock: { now: () => 1_000 },
      channelFactory: isolatedChannelFactory(),
    });
    await expect(expired.authorizeEditor(scope())).rejects.toBeInstanceOf(
      SessionAuthorizationError,
    );
    expired.dispose();
  });

  it("rejects tampered session and workspace identities at the schema boundary", () => {
    expect(
      () =>
        new BrowserSessionLifecycleCoordinator({
          initialSession: {
            userId: "not-a-uuid",
            expiresAt: 10_000,
            workspaceIds: [WORKSPACE_A],
          },
          draftStore: { clearForUser: async () => undefined },
          clock: { now: () => 1_000 },
          channelFactory: isolatedChannelFactory(),
        }),
    ).toThrow();

    expect(
      () =>
        new BrowserSessionLifecycleCoordinator({
          initialSession: {
            userId: USER_A,
            expiresAt: 10_000,
            workspaceIds: [WORKSPACE_A, "forged-workspace"],
          },
          draftStore: { clearForUser: async () => undefined },
          clock: { now: () => 1_000 },
          channelFactory: isolatedChannelFactory(),
        }),
    ).toThrow();
  });

  it("clears and locks locally and broadcasts inbound logout even when network logout rejects", async () => {
    const clearForUser = vi.fn(async () => undefined);
    const channelFactory = isolatedChannelFactory();
    const coordinatorA = new BrowserSessionLifecycleCoordinator({
      initialSession: liveSession(),
      draftStore: { clearForUser },
      clock: { now: () => 1_000 },
      channelFactory,
    });
    const coordinatorB = new BrowserSessionLifecycleCoordinator({
      initialSession: liveSession(),
      draftStore: { clearForUser },
      clock: { now: () => 1_000 },
      channelFactory,
    });
    const lockA = vi.fn(async () => undefined);
    const lockB = vi.fn(async () => undefined);
    coordinatorA.registerEditor(scope(), lockA);
    coordinatorB.registerEditor(scope(), lockB);
    const networkFailure = new Error("network logout failed");

    await expect(
      coordinatorA.logout(async () => {
        throw networkFailure;
      }),
    ).rejects.toBe(networkFailure);

    expect(lockA).toHaveBeenCalledOnce();
    expect(clearForUser).toHaveBeenCalledWith(USER_A);
    await vi.waitFor(() => expect(lockB).toHaveBeenCalledOnce());
    await expect(coordinatorB.authorizeEditor(scope())).rejects.toBeInstanceOf(
      SessionAuthorizationError,
    );

    coordinatorA.dispose();
    coordinatorB.dispose();
  });

  it("finishes clearing and locking the prior account before authorizing the new account", async () => {
    let finishClear: (() => void) | undefined;
    const clearForUser = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const coordinator = new BrowserSessionLifecycleCoordinator({
      initialSession: liveSession(),
      draftStore: { clearForUser },
      clock: { now: () => 1_000 },
      channelFactory: isolatedChannelFactory(),
    });
    const lockPriorAccount = vi.fn(async () => undefined);
    coordinator.registerEditor(scope(), lockPriorAccount);

    const switched = coordinator.switchAccount(
      liveSession({ userId: USER_B, workspaceIds: [WORKSPACE_B] }),
    );
    let newAccountExposed = false;
    const authorization = coordinator
      .authorizeEditor(scope({ userId: USER_B, workspaceId: WORKSPACE_B }))
      .then(() => {
        newAccountExposed = true;
      });

    await vi.waitFor(() => expect(clearForUser).toHaveBeenCalledWith(USER_A));
    expect(lockPriorAccount).toHaveBeenCalledOnce();
    expect(newAccountExposed).toBe(false);

    finishClear?.();
    await switched;
    await authorization;
    expect(newAccountExposed).toBe(true);
    await expect(coordinator.authorizeEditor(scope())).rejects.toBeInstanceOf(
      SessionAuthorizationError,
    );
    coordinator.dispose();
  });

  it("revokes registered editors removed by a same-user workspace authorization change", async () => {
    const coordinator = new BrowserSessionLifecycleCoordinator({
      initialSession: liveSession(),
      draftStore: { clearForUser: async () => undefined },
      clock: { now: () => 1_000 },
      channelFactory: isolatedChannelFactory(),
    });
    const lockRevokedWorkspace = vi.fn(async () => undefined);
    coordinator.registerEditor(scope(), lockRevokedWorkspace);

    await coordinator.switchAccount(liveSession({ workspaceIds: [WORKSPACE_B] }));

    expect(lockRevokedWorkspace).toHaveBeenCalledOnce();
    await expect(coordinator.authorizeEditor(scope())).rejects.toBeInstanceOf(
      SessionAuthorizationError,
    );
    await expect(
      coordinator.authorizeEditor(scope({ workspaceId: WORKSPACE_B })),
    ).resolves.toBeUndefined();
    coordinator.dispose();
  });

  it("locks registered editors at the exact expiresAt boundary", async () => {
    const clock = new ManualSessionClock(1_000);
    const coordinator = new BrowserSessionLifecycleCoordinator({
      initialSession: liveSession({ expiresAt: 2_000 }),
      draftStore: { clearForUser: async () => undefined },
      clock,
      channelFactory: isolatedChannelFactory(),
    });
    const lockExpiredEditor = vi.fn(async () => undefined);
    coordinator.registerEditor(scope(), lockExpiredEditor);

    clock.advanceTo(1_999);
    await Promise.resolve();
    expect(lockExpiredEditor).not.toHaveBeenCalled();

    clock.advanceTo(2_000);
    await vi.waitFor(() => expect(lockExpiredEditor).toHaveBeenCalledOnce());
    await expect(coordinator.authorizeEditor(scope())).rejects.toBeInstanceOf(
      SessionAuthorizationError,
    );
    coordinator.dispose();
  });
});
