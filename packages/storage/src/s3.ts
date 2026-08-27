import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ObjectStorageError,
  type ObjectStoragePort,
  type ObjectStoragePutInput,
  type ObjectStoragePutResult,
} from "./port.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9!_.*'()/-]+$/;

export interface S3ObjectStorageOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 900 ||
    key.startsWith("/") ||
    key.includes("..") ||
    !SAFE_KEY_PATTERN.test(key)
  ) {
    throw new ObjectStorageError("Object key is invalid");
  }
}

/**
 * S3-compatible object storage adapter. Never surfaces raw SDK errors or
 * provider credentials to callers; every failure is normalized to
 * ObjectStorageError with a scrubbed message.
 */
export class S3ObjectStorage implements ObjectStoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private destroyed = false;

  constructor(options: S3ObjectStorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.client.destroy();
  }

  async put(input: ObjectStoragePutInput): Promise<ObjectStoragePutResult> {
    assertSafeKey(input.key);
    if (!SHA256_PATTERN.test(input.sha256)) {
      throw new ObjectStorageError("Object checksum is invalid");
    }
    if (input.contentLength !== input.body.byteLength) {
      throw new ObjectStorageError("Declared content length does not match the object body");
    }
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
          ChecksumSHA256: Buffer.from(input.sha256, "hex").toString("base64"),
        }),
      );
      return { etag: result.ETag ?? "" };
    } catch {
      throw new ObjectStorageError("Object storage write failed");
    }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    assertSafeKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = result.Body;
      if (!body) throw new ObjectStorageError("Object storage read returned no content");
      if (body instanceof Readable) {
        return Readable.toWeb(body) as ReadableStream<Uint8Array>;
      }
      return body.transformToWebStream();
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      throw new ObjectStorageError("Object storage read failed");
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      throw new ObjectStorageError("Object storage delete failed");
    }
  }

  async createDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    assertSafeKey(key);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3_600) {
      throw new ObjectStorageError("Download URL expiry is out of range");
    }
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    } catch {
      throw new ObjectStorageError("Object storage URL signing failed");
    }
  }
}
