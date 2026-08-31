import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../", import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

describe("Backup schedule and destructive guard", () => {
  it("runs an encrypted backup daily with strict failure and 30-day retention", async () => {
    const [script, service, timer] = await Promise.all([
      source("infra/backup/backup.sh"),
      source("infra/backup/backup.service"),
      source("infra/backup/backup.timer"),
    ]);

    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("umask 077");
    expect(script).toMatch(/pg_dump/u);
    expect(script).toMatch(/aws.+s3.+sync|mc.+mirror/u);
    expect(script).toMatch(/openssl.+aes-256/u);
    expect(script).toContain("BACKUP_ENCRYPTION_KEY");
    expect(script).toMatch(/mtime.+30/u);
    expect(script).toContain('"event":"BACKUP_FAILED"');
    expect(script).toContain('"type":"backup.verify"');
    expect(script).not.toMatch(/set -x/u);

    expect(service).toContain("ExecStart=/opt/glyphquire/infra/backup/backup.sh");
    expect(timer).toContain("OnCalendar=daily");
    expect(timer).toContain("Persistent=true");
  });

  it("blocks a destructive operation when its preflight backup fails", async () => {
    const hook = await source("infra/backup/pre-destructive-hook.sh");
    expect(hook).toContain("set -Eeuo pipefail");
    expect(hook).toContain("backup.sh");
    expect(hook).not.toMatch(/\|\|\s*true/u);
  });
});
