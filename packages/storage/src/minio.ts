import { S3ObjectStorage } from "./s3.js";

export interface S3EnvLike {
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_BUCKET: string;
  S3_REGION: string;
}

/**
 * MinIO always requires path-style addressing (bucket-in-path rather than
 * bucket-as-subdomain), since local/self-hosted endpoints rarely have
 * per-bucket DNS entries.
 */
export function createMinioObjectStorage(env: S3EnvLike): S3ObjectStorage {
  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
    forcePathStyle: true,
  });
}

/**
 * Production S3/R2 settings stay environment-driven and use virtual-hosted
 * addressing by default.
 */
export function createS3ObjectStorage(env: S3EnvLike): S3ObjectStorage {
  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
    forcePathStyle: false,
  });
}
