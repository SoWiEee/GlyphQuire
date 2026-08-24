/**
 * Minimal Promise-based seam over the raw IndexedDB API. Every higher-level
 * store (DraftStore today) goes through this module instead of touching
 * `indexedDB` directly, so tests can inject `fake-indexeddb` and production
 * code stays free of manual `onsuccess`/`onerror` wiring.
 */

export interface IndexConfig {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
}

export interface ObjectStoreConfig {
  name: string;
  keyPath: string | string[];
  indexes?: IndexConfig[];
}

export interface DatabaseConfig {
  name: string;
  version: number;
  stores: ObjectStoreConfig[];
}

/** Wraps a single IDBRequest as a Promise that settles with its result. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Opens (and, on first use, provisions) a database against the given
 * factory. Defaults to the ambient `indexedDB` global so production code
 * needs no wiring; tests pass a `fake-indexeddb` factory explicitly (or via
 * `fake-indexeddb/auto`, which replaces the global itself).
 */
export function openDatabase(
  config: DatabaseConfig,
  indexedDbFactory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<IDBDatabase> {
  if (!indexedDbFactory) {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDbFactory.open(config.name, config.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of config.stores) {
        const objectStore = db.objectStoreNames.contains(store.name)
          ? request.transaction?.objectStore(store.name)
          : db.createObjectStore(store.name, { keyPath: store.keyPath });
        if (!objectStore) continue;
        for (const index of store.indexes ?? []) {
          if (!objectStore.indexNames.contains(index.name)) {
            objectStore.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
          }
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB database"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked by another connection"));
  });
}

/**
 * Runs `run` inside a single IndexedDB transaction and resolves once the
 * transaction commits. `run` may perform any number of synchronous store
 * requests against `tx`; if it throws (or its returned promise rejects) the
 * transaction is aborted and the rejection propagates.
 */
export function runTransaction<T>(
  db: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result: T;
    let hasResult = false;
    let settled = false;

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(hasResult ? result : (undefined as T));
    };
    tx.onerror = () => {
      if (settled) return;
      settled = true;
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    };

    Promise.resolve()
      .then(() => run(tx))
      .then((value) => {
        result = value;
        hasResult = true;
      })
      .catch((error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        try {
          tx.abort();
        } catch {
          // Transaction already finished (committed/aborted) — nothing to do.
        }
      });
  });
}
