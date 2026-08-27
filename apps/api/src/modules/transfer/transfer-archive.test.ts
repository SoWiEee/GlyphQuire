import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocumentEngine } from "@glyphquire/document-engine";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_FILES,
  MAX_EXPANDED_BYTES,
} from "./ArchiveLimits.js";
import { ArchiveReader } from "./ArchiveReader.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "glyphquire-archive-test-"));
  temporaryRoots.push(root);
  return root;
}

function archive(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00.000Z") });
}

function smallReader(root: string, limits: Record<string, number> = {}): ArchiveReader {
  return new ArchiveReader({
    temporaryRoot: root,
    limits: {
      maxArchiveBytes: 4_096,
      maxArchiveFiles: 8,
      maxExpandedBytes: 256,
      maxArchiveEntryBytes: 128,
      ...limits,
    },
  });
}

async function expectInvalid(read: Promise<unknown>): Promise<void> {
  await expect(read).rejects.toMatchObject({ code: "IMPORT_INVALID", status: 400 });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ArchiveReader", () => {
  it("publishes the exact immutable import limits", () => {
    expect(MAX_ARCHIVE_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_ARCHIVE_FILES).toBe(256);
    expect(MAX_EXPANDED_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_ARCHIVE_ENTRY_BYTES).toBe(5 * 1024 * 1024);
  });

  it("extracts regular entries beneath a dedicated temporary directory", async () => {
    const root = await temporaryRoot();
    const result = await smallReader(root).readZip(
      archive({
        "notes/note.md": strToU8("# Note\n"),
        "assets/image.bin": new Uint8Array([1, 2, 3]),
      }),
    );

    expect(result.directory.startsWith(`${root}/`)).toBe(true);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      "notes/note.md",
      "assets/image.bin",
    ]);
    expect(await readFile(result.entries[0]!.absolutePath, "utf8")).toBe("# Note\n");
    expect(result.entries[0]!.absolutePath.startsWith(`${result.directory}/`)).toBe(true);

    await result.cleanup();
    await expect(access(result.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["parent traversal", "../outside.md"],
    ["backslash traversal", "..\\outside.md"],
    ["POSIX absolute path", "/outside.md"],
    ["Windows drive path", "C:\\outside.md"],
  ])("rejects %s without writing outside its temporary directory", async (_label, name) => {
    const root = await temporaryRoot();
    const reader = smallReader(root);

    await expectInvalid(reader.readZip(archive({ [name]: strToU8("attacker") })));

    expect(await readdir(root)).toEqual([]);
    await expect(access(join(root, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects two names that canonicalize to the same relative path", async () => {
    const root = await temporaryRoot();
    await expectInvalid(
      smallReader(root).readZip(
        archive({
          "notes/./note.md": strToU8("first"),
          "notes/note.md": strToU8("second"),
        }),
      ),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects Unix symbolic-link entries", async () => {
    const root = await temporaryRoot();
    const zipped = zipSync(
      {
        link: [
          strToU8("notes/note.md"),
          { level: 0, os: 3, attrs: 0o120777 << 16, mtime: new Date("2026-01-01") },
        ],
      },
      { level: 0 },
    );

    await expectInvalid(smallReader(root).readZip(zipped));
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ["random bytes", new Uint8Array([1, 2, 3, 4])],
    ["truncated ZIP", archive({ "note.md": strToU8("body") }).subarray(0, 20)],
  ])("rejects malformed archives: %s", async (_label, input) => {
    const root = await temporaryRoot();
    await expectInvalid(smallReader(root).readZip(input));
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects an archive over the compressed-byte limit before creating a directory", async () => {
    const root = await temporaryRoot();
    await expectInvalid(
      smallReader(root, { maxArchiveBytes: 8 }).readZip(new Uint8Array(9).fill(1)),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects more entries than the file-count limit", async () => {
    const root = await temporaryRoot();
    await expectInvalid(
      smallReader(root, { maxArchiveFiles: 2 }).readZip(
        archive({
          "one.txt": strToU8("1"),
          "two.txt": strToU8("2"),
          "three.txt": strToU8("3"),
        }),
      ),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects an entry over the per-entry expanded-byte limit", async () => {
    const root = await temporaryRoot();
    await expectInvalid(
      smallReader(root, { maxArchiveEntryBytes: 4 }).readZip(
        archive({ "large.txt": strToU8("12345") }),
      ),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects an archive over the aggregate expanded-byte limit", async () => {
    const root = await temporaryRoot();
    await expectInvalid(
      smallReader(root, { maxExpandedBytes: 8 }).readZip(
        archive({ "one.txt": strToU8("12345"), "two.txt": strToU8("67890") }),
      ),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves unsupported block source for the document-engine caller seam", async () => {
    const root = await temporaryRoot();
    const source = '---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nSentinel body.\n:::\n';
    const result = await smallReader(root).readZip(archive({ "note.md": strToU8(source) }));
    const extracted = await readFile(result.entries[0]!.absolutePath, "utf8");

    const parsed = createDocumentEngine().parse(extracted);
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toBe(source);
    if (!parsed.ok) throw new Error("expected document-engine to retain unsupported source");
    expect(createDocumentEngine().serialize(parsed.document)).toContain(":::future");

    await result.cleanup();
  });

  it("leaves malformed custom syntax for the document-engine caller to reject", async () => {
    const root = await temporaryRoot();
    const source =
      '---\nglyphquire-spec: 1\n---\n\n:::callout{type="warning"\nSentinel body.\n:::\n';
    const result = await smallReader(root).readZip(archive({ "note.md": strToU8(source) }));
    const extracted = await readFile(result.entries[0]!.absolutePath, "utf8");

    const parsed = createDocumentEngine().parse(extracted);
    expect(parsed.ok).toBe(false);
    expect(parsed.source).toBe(source);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({ code: "DIRECTIVE_SYNTAX_INVALID", severity: "error" }),
    );

    await result.cleanup();
  });
});
