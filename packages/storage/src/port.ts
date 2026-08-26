export interface ObjectStoragePutInput {
  key: string;
  body: Buffer;
  contentType: string;
  contentLength: number;
  sha256: string;
}

export interface ObjectStoragePutResult {
  etag: string;
}

/**
 * Provider-neutral boundary over S3-compatible object storage. Concrete
 * adapters (see s3.ts / minio.ts) never leak provider credentials or raw SDK
 * errors through this interface.
 */
export interface ObjectStoragePort {
  put(input: ObjectStoragePutInput): Promise<ObjectStoragePutResult>;
  get(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
  createDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export class ObjectStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStorageError";
  }
}
