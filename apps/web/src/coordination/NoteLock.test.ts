import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { NoteLock } from "./NoteLock.js";
import type { NoteScope } from "./TabChannel.js";
import type { LockManagerLike, LockRequestOptions } from "./NoteLock.js";

interface QueueEntry {
  resolve: () => void;
  reject: (error: unknown) => void;
}

function abortError(): Error {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * A faithful, minimal stand-in for `navigator.locks` covering exactly the
 * subset NoteLock uses: exclusive mode, `ifAvailable` (grant-or-null,
 * never queues), and FIFO queueing for blocking requests with `signal`-based
 * cancellation of a still-queued request. One instance is shared by every
 * simulated "tab" in a fixture, exactly like the single browser-wide
 * LockManager every real tab shares.
 */
class FakeLockManager implements LockManagerLike {
  private readonly held = new Set<string>();
  private readonly queues = new Map<string, QueueEntry[]>();
  readonly requestedNames: string[] = [];

  async request<T>(
    name: string,
    options: LockRequestOptions,
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T> {
    this.requestedNames.push(name);
    if (options.ifAvailable) {
      if (this.held.has(name)) return callback(null);
      return this.runHolding(name, callback);
    }

    if (this.held.has(name)) {
      await new Promise<void>((resolve, reject) => {
        const entry: QueueEntry = { resolve, reject };
        const queue = this.queues.get(name) ?? [];
        queue.push(entry);
        this.queues.set(name, queue);
        options.signal?.addEventListener("abort", () => {
          const queued = this.queues.get(name);
          const index = queued?.indexOf(entry) ?? -1;
          if (queued && index !== -1) {
            queued.splice(index, 1);
            reject(abortError());
          }
        });
      });
    } else if (options.signal?.aborted) {
      throw abortError();
    }

    return this.runHolding(name, callback);
  }

  private async runHolding<T>(name: string, callback: (lock: unknown) => Promise<T>): Promise<T> {
    this.held.add(name);
    try {
      return await callback({});
    } finally {
      this.held.delete(name);
      const next = this.queues.get(name)?.shift();
      next?.resolve();
    }
  }
}

/**
 * Every test gets its own BroadcastChannel name, note id, and FakeLockManager
 * so tabs from one test can never observe messages or lock contention from
 * another. One FakeLockManager is shared across every simulated tab in a
 * fixture, matching the single browser-wide `navigator.locks` every real tab
 * shares.
 */
function isolatedFixture() {
  const scope: NoteScope = {
    userId: randomUUID(),
    workspaceId: randomUUID(),
    noteId: randomUUID(),
  };
  const lockManager = new FakeLockManager();
  const tabs: NoteLock[] = [];
  const makeTab = (overrides: Partial<NoteScope> = {}) => {
    const tab = new NoteLock(
      { ...scope, ...overrides },
      {
        lockManager,
        tabId: randomUUID(),
        takeoverWaitMs: 200,
        ownerDiscoveryWaitMs: 100,
      },
    );
    tabs.push(tab);
    return tab;
  };
  return { scope, lockManager, makeTab, tabs };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("NoteLock", () => {
  const openFixtures: NoteLock[][] = [];

  afterEach(() => {
    for (const tabs of openFixtures.splice(0)) {
      for (const tab of tabs) tab.dispose();
    }
  });

  function useFixture() {
    const fixture = isolatedFixture();
    openFixtures.push(fixture.tabs);
    return fixture;
  }

  it("grants the write lock to the first tab that opens a note", async () => {
    const { makeTab } = useFixture();
    const tabA = makeTab();

    const acquired = await tabA.acquire();

    expect(acquired).toBe(true);
    expect(tabA.isOwner()).toBe(true);
  });

  it("keeps a second tab read-only while the first tab holds the note", async () => {
    const { makeTab } = useFixture();
    const tabA = makeTab();
    const tabB = makeTab();

    expect(await tabA.acquire()).toBe(true);
    expect(await tabB.acquire()).toBe(false);
    expect(tabB.isOwner()).toBe(false);
    // The owner is unaffected by a second tab's failed acquire attempt.
    expect(tabA.isOwner()).toBe(true);
  });

  it("scopes the Web Lock name by user, workspace, and note", async () => {
    const { scope, lockManager, makeTab } = useFixture();
    const tab = makeTab();

    await tab.acquire();

    expect(lockManager.requestedNames).toEqual([
      `glyphquire-note-lock:${scope.userId}:${scope.workspaceId}:${scope.noteId}`,
    ]);
  });

  it("does not let one browser identity block another identity's copy of the same note id", async () => {
    const { makeTab } = useFixture();
    const userA = makeTab();
    const userB = makeTab({ userId: randomUUID() });

    expect(await userA.acquire()).toBe(true);
    expect(await userB.acquire()).toBe(true);
  });

  it("only transfers write ownership after an explicit takeover request", async () => {
    const { makeTab } = useFixture();
    const tabA = makeTab();
    const tabB = makeTab();

    expect(await tabA.acquire()).toBe(true);
    expect(await tabB.acquire()).toBe(false);

    // Without a takeover, tab A keeps ownership indefinitely.
    await delay(20);
    expect(tabA.isOwner()).toBe(true);
    expect(tabB.isOwner()).toBe(false);

    const takeover = await tabB.requestTakeover();

    expect(takeover).toBe(true);
    expect(tabB.isOwner()).toBe(true);
    expect(tabA.isOwner()).toBe(false);
  });

  it("notifies the previous writer synchronously when a targeted takeover releases it", async () => {
    const { makeTab } = useFixture();
    const tabA = makeTab();
    const tabB = makeTab();
    const ownership: boolean[] = [];
    tabA.subscribeOwnership((owned) => ownership.push(owned));

    await tabA.acquire();
    await tabB.acquire();
    await tabB.requestTakeover();

    expect(ownership).toEqual([true, false]);
  });

  it("lets the new owner write again immediately after taking over", async () => {
    const { makeTab } = useFixture();
    const tabA = makeTab();
    const tabB = makeTab();

    await tabA.acquire();
    await tabB.requestTakeover();

    // The old owner can no longer re-acquire without its own takeover.
    expect(await tabA.acquire()).toBe(false);
  });

  it("grants a simultaneous takeover request to exactly one of two racing tabs", async () => {
    const { makeTab } = useFixture();
    const owner = makeTab();
    const tabB = makeTab();
    const tabC = makeTab();

    await owner.acquire();

    // Both requests fire back to back, before either can observe the other.
    const [bWon, cWon] = await Promise.all([tabB.requestTakeover(), tabC.requestTakeover()]);

    // Both calls resolve definitively (no dangling promise for the loser) —
    // exactly one winner, one loser, never both or neither.
    expect(bWon !== cWon).toBe(true);

    const winner = bWon ? tabB : tabC;
    const loser = bWon ? tabC : tabB;
    expect(winner.isOwner()).toBe(true);
    expect(loser.isOwner()).toBe(false);
    expect(owner.isOwner()).toBe(false);
  });

  it("lets a second tab acquire once the first tab releases voluntarily", async () => {
    const { makeTab } = useFixture();
    const tabA = makeTab();
    const tabB = makeTab();

    await tabA.acquire();
    tabA.release();
    expect(tabA.isOwner()).toBe(false);

    // Releasing resolves the held lock's internal promise asynchronously
    // (the same as a real `navigator.locks` callback settling); give that a
    // tick to actually free the lock before the next tab races for it.
    await delay(10);
    expect(await tabB.acquire()).toBe(true);
  });

  it("is a no-op to release a note this tab does not own", () => {
    const { makeTab } = useFixture();
    const tab = makeTab();

    expect(() => tab.release()).not.toThrow();
    expect(tab.isOwner()).toBe(false);
  });
});
