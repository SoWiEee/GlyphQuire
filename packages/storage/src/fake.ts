import { createHash } from "node:crypto";
import {
  ObjectStorageError,
  type ObjectStoragePort,
  type ObjectStoragePutInput,
  type ObjectStoragePutResult,
} from "./port.js";

export interface InMemoryObjectStorageHooks {
  beforePut?(input: ObjectStoragePutInput): void | Promise<void>;
  afterPut?(input: ObjectStoragePutInput): void | Promise<void>;
  beforeDelete?(key: string): void | Promise<void>;
}

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/** In-memory ObjectStoragePort fake for unit/service tests. Not for production use. */
export class InMemoryObjectStorage implements ObjectStoragePort {
  private readonly objects = new Map<string, StoredObject>();

  constructor(private readonly hooks: InMemoryObjectStorageHooks = {}) {}

  destroy(): void {}

  async put(input: ObjectStoragePutInput): Promise<ObjectStoragePutResult> {
    await this.hooks.beforePut?.(input);
    if (input.contentLength !== input.body.byteLength) {
      throw new ObjectStorageError("Declared content length does not match the object body");
    }
    const actualHash = createHash("sha256").update(input.body).digest("hex");
    if (actualHash !== input.sha256) {
      throw new ObjectStorageError("Object checksum does not match the object body");
    }
    this.objects.set(input.key, { body: Buffer.from(input.body), contentType: input.contentType });
    await this.hooks.afterPut?.(input);
    return { etag: actualHash };
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const stored = this.objects.get(key);
    if (!stored) throw new ObjectStorageError("Object not found");
    const body = stored.body;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    });
  }

  async delete(key: string): Promise<void> {
    await this.hooks.beforeDelete?.(key);
    this.objects.delete(key);
  }

  async createDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    if (!this.objects.has(key)) throw new ObjectStorageError("Object not found");
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3_600) {
      throw new ObjectStorageError("Download URL expiry is out of range");
    }
    const expiresAt = Date.now() + expiresInSeconds * 1_000;
    return `memory://${key}?expires=${expiresAt}`;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  size(): number {
    return this.objects.size;
  }
}
