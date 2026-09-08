import { S3ObjectStorage } from "./s3.js";

export interface S3EnvLike {
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_BUCKET: string;
  S3_REGION: string;
}

function createObjectStorage(env: S3EnvLike, forcePathStyle: boolean): S3ObjectStorage {
  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
    forcePathStyle,
  });
}

/** MinIO requires path-style addressing for local/self-hosted endpoints. */
export function createMinioObjectStorage(env: S3EnvLike): S3ObjectStorage {
  return createObjectStorage(env, true);
}

/**
 * Production S3/R2 settings stay environment-driven and use virtual-hosted
 * addressing by default.
 */
export function createS3ObjectStorage(env: S3EnvLike): S3ObjectStorage {
  return createObjectStorage(env, false);
}
