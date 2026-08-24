import { describe, expect, it, vi } from "vitest";
import { EditorLifecycleController } from "./EditorLifecycleController.js";
import type { EditorLifecycleAdapter } from "./EditorLifecycleController.js";

class FakeLifecycleAdapter implements EditorLifecycleAdapter {
  private readonly online = new Set<() => void>();
  private readonly blur = new Set<() => void>();
  private readonly navigation = new Set<() => void>();

  onOnline(listener: () => void): () => void {
    this.online.add(listener);
    return () => this.online.delete(listener);
  }

  onBlur(listener: () => void): () => void {
    this.blur.add(listener);
    return () => this.blur.delete(listener);
  }

  onNavigation(listener: () => void): () => void {
    this.navigation.add(listener);
    return () => this.navigation.delete(listener);
  }

  emitOnline(): void {
    for (const listener of this.online) listener();
  }

  emitBlur(): void {
    for (const listener of this.blur) listener();
  }

  emitNavigation(): void {
    for (const listener of this.navigation) listener();
  }
}

describe("EditorLifecycleController", () => {
  it("routes reconnect to retry and blur/navigation to immediate saves", async () => {
    const adapter = new FakeLifecycleAdapter();
    const retryNow = vi.fn(async () => undefined);
    const saveNow = vi.fn(async () => undefined);
    const controller = new EditorLifecycleController(adapter, { retryNow, saveNow });

    adapter.emitOnline();
    adapter.emitBlur();
    adapter.emitNavigation();
    await Promise.resolve();

    expect(retryNow).toHaveBeenCalledOnce();
    expect(saveNow).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("removes every adapter hook on teardown", async () => {
    const adapter = new FakeLifecycleAdapter();
    const retryNow = vi.fn(async () => undefined);
    const saveNow = vi.fn(async () => undefined);
    const controller = new EditorLifecycleController(adapter, { retryNow, saveNow });

    controller.dispose();
    controller.dispose();
    adapter.emitOnline();
    adapter.emitBlur();
    adapter.emitNavigation();
    await Promise.resolve();

    expect(retryNow).not.toHaveBeenCalled();
    expect(saveNow).not.toHaveBeenCalled();
  });
});
