import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { S3ObjectStorage, ObjectStorageError } from "@glyphquire/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises a real MinIO bucket-policy denial: a scoped credential granted
// access to only one bucket must be rejected -- as a normalized
// ObjectStorageError, never a raw SDK/provider error -- when the adapter is
// pointed at a bucket outside its policy, while continuing to work against
// its allowed bucket. This provisions throwaway MinIO users/policies via the
// `mc` client bundled in the running minio container, so it requires both
// Docker and a reachable MinIO service; it no-ops (not fails) when either is
// unavailable, matching the other environment-gated integration suites here.

const execFileAsync = promisify(execFile);
const endpoint = process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000";
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const allowedBucket = `gq-priv-allowed-${suffix}`;
const deniedBucket = `gq-priv-denied-${suffix}`;
const scopedUser = `gq-priv-user-${suffix}`;
const scopedPassword = `gq-priv-pass-${suffix}-x1`;
const policyName = `gq-priv-policy-${suffix}`;

const EXEC_TIMEOUT_MS = 10_000;

async function findMinioContainerId(): Promise<string | undefined> {
  const { stdout } = await execFileAsync(
    "docker",
    ["ps", "--filter", "name=minio", "--format", "{{.ID}}"],
    { timeout: EXEC_TIMEOUT_MS },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

async function mc(containerId: string, ...args: string[]): Promise<void> {
  await execFileAsync("docker", ["exec", containerId, "mc", ...args], {
    timeout: EXEC_TIMEOUT_MS,
  });
}

/**
 * Writes `content` to `path` inside the container. Piping through the
 * child process's stdin (`docker exec -i ... sh -c "cat > path"`) proved
 * unreliable -- the write could race the exec'd shell reading its stdin.
 * Base64-encoding into the command line side-steps that entirely.
 */
async function writeFileInContainer(
  containerId: string,
  path: string,
  content: string,
): Promise<void> {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  await execFileAsync(
    "docker",
    ["exec", containerId, "sh", "-c", `echo ${encoded} | base64 -d > ${path}`],
    { timeout: EXEC_TIMEOUT_MS },
  );
}

describe("S3ObjectStorage bucket-policy privilege boundary (MinIO)", () => {
  let ready = false;
  let containerId: string | undefined;

  beforeAll(async () => {
    try {
      containerId = await findMinioContainerId();
      if (!containerId) return;

      await mc(
        containerId,
        "alias",
        "set",
        "gqpriv",
        "http://127.0.0.1:9000",
        "glyphquire",
        "glyphquire_dev",
      );
      await mc(containerId, "mb", "--ignore-existing", `gqpriv/${allowedBucket}`);
      await mc(containerId, "mb", "--ignore-existing", `gqpriv/${deniedBucket}`);
      await mc(containerId, "admin", "user", "add", "gqpriv", scopedUser, scopedPassword);

      const policyJson = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
            Resource: [`arn:aws:s3:::${allowedBucket}`, `arn:aws:s3:::${allowedBucket}/*`],
          },
        ],
      });
      const policyPath = `/tmp/${policyName}.json`;
      await writeFileInContainer(containerId, policyPath, policyJson);
      await mc(containerId, "admin", "policy", "create", "gqpriv", policyName, policyPath);
      await mc(
        containerId,
        "admin",
        "policy",
        "attach",
        "gqpriv",
        policyName,
        "--user",
        scopedUser,
      );
      ready = true;
    } catch {
      ready = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (!containerId || !ready) return;
    try {
      await mc(
        containerId,
        "admin",
        "policy",
        "detach",
        "gqpriv",
        policyName,
        "--user",
        scopedUser,
      );
    } catch {
      /* best-effort cleanup */
    }
    try {
      await mc(containerId, "admin", "policy", "rm", "gqpriv", policyName);
    } catch {
      /* best-effort cleanup */
    }
    try {
      await mc(containerId, "admin", "user", "remove", "gqpriv", scopedUser);
    } catch {
      /* best-effort cleanup */
    }
    try {
      await mc(containerId, "rb", "--force", `gqpriv/${allowedBucket}`);
    } catch {
      /* best-effort cleanup */
    }
    try {
      await mc(containerId, "rb", "--force", `gqpriv/${deniedBucket}`);
    } catch {
      /* best-effort cleanup */
    }
  }, 30_000);

  it("normalizes an out-of-policy bucket write to ObjectStorageError, never a raw provider error", async () => {
    if (!ready) return;
    const denied = new S3ObjectStorage({
      endpoint,
      region: "us-east-1",
      accessKeyId: scopedUser,
      secretAccessKey: scopedPassword,
      bucket: deniedBucket,
      forcePathStyle: true,
    });

    const body = Buffer.from("privilege-boundary-probe");
    let caught: unknown;
    try {
      await denied.put({
        key: "workspace/w/assets/a/original",
        body,
        contentType: "text/plain",
        contentLength: body.byteLength,
        sha256: "0".repeat(64),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ObjectStorageError);
    // The normalized error must not leak the provider's raw AccessDenied
    // envelope, request id, or bucket ARN.
    expect(String((caught as Error).message)).not.toMatch(/AccessDenied|arn:aws/i);
  });

  it("continues to serve the same credential's authorized bucket", async () => {
    if (!ready) return;
    const allowed = new S3ObjectStorage({
      endpoint,
      region: "us-east-1",
      accessKeyId: scopedUser,
      secretAccessKey: scopedPassword,
      bucket: allowedBucket,
      forcePathStyle: true,
    });

    const body = Buffer.from("authorized-write");
    const { createHash } = await import("node:crypto");
    const key = "workspace/w/assets/a/original";
    await allowed.put({
      key,
      body,
      contentType: "text/plain",
      contentLength: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    const stream = await allowed.get(key);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("authorized-write");
  });
});
