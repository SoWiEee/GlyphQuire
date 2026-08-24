export interface EditorLifecycleAdapter {
  onOnline(listener: () => void): () => void;
  onBlur(listener: () => void): () => void;
  onNavigation(listener: () => void): () => void;
}

export interface EditorLifecycleTarget {
  retryNow(): Promise<void>;
  saveNow(): Promise<void>;
}

export interface BrowserEventTargetLike {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/** Browser events used by the editing core; router note changes may inject the same port. */
export class BrowserEditorLifecycleAdapter implements EditorLifecycleAdapter {
  constructor(private readonly eventTarget: BrowserEventTargetLike = globalThis.window) {}

  onOnline(listener: () => void): () => void {
    return this.subscribe("online", listener);
  }

  onBlur(listener: () => void): () => void {
    return this.subscribe("blur", listener);
  }

  onNavigation(listener: () => void): () => void {
    return this.subscribe("pagehide", listener);
  }

  private subscribe(type: string, listener: () => void): () => void {
    const eventListener: EventListener = () => listener();
    this.eventTarget.addEventListener(type, eventListener);
    return () => this.eventTarget.removeEventListener(type, eventListener);
  }
}

/**
 * Connects browser lifecycle signals to the authoritative save state machine.
 * AutosaveController remains responsible for debounce and single-flight rules.
 */
export class EditorLifecycleController {
  private readonly unsubscribe: Array<() => void>;
  private disposed = false;

  constructor(adapter: EditorLifecycleAdapter, target: EditorLifecycleTarget) {
    const safely = (operation: () => Promise<void>): void => {
      void operation().catch(() => undefined);
    };
    this.unsubscribe = [
      adapter.onOnline(() => safely(() => target.retryNow())),
      adapter.onBlur(() => safely(() => target.saveNow())),
      adapter.onNavigation(() => safely(() => target.saveNow())),
    ];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }
}
