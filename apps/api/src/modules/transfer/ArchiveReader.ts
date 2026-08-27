import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { strFromU8, Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { PublicApiError } from "../../middleware/error-handler.js";
import { resolveArchiveLimits, type ArchiveLimits } from "./ArchiveLimits.js";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTION_FLAGS = 0x2041;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_DIRECTORY_TYPE = 0x4000;
const UNIX_REGULAR_TYPE = 0x8000;
const UNIX_SYMLINK_TYPE = 0xa000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const MAX_CANONICAL_PATH_BYTES = 1_024;
const MAX_PATH_SEGMENT_BYTES = 255;

interface CentralEntry {
  rawName: string;
  relativePath: string;
  compressedSize: number;
  expandedSize: number;
  compression: number;
  crc32: number;
  flags: number;
  localHeaderOffset: number;
  directory: boolean;
}

export interface ExtractedArchiveEntry {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

export interface ExtractedArchive {
  directory: string;
  entries: readonly ExtractedArchiveEntry[];
  cleanup(): Promise<void>;
}

export interface ArchiveReaderOptions {
  limits?: Partial<ArchiveLimits>;
  /** Trusted parent used only to place a fresh, private extraction directory. */
  temporaryRoot?: string;
}

function invalidArchive(): never {
  throw new PublicApiError("IMPORT_INVALID", 400);
}

function invalidArchiveError(): PublicApiError {
  return new PublicApiError("IMPORT_INVALID", 400);
}

function readUint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) invalidArchive();
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) invalidArchive();
  return view.getUint32(offset, true);
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  try {
    const decoded = strFromU8(bytes, (flags & UTF8_FLAG) === 0);
    if (decoded.includes("\uFFFD")) invalidArchive();
    return decoded;
  } catch {
    return invalidArchive();
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function canonicalRelativePath(rawName: string): string {
  if (rawName.includes("\\")) invalidArchive();
  if (rawName.length === 0 || containsControlCharacter(rawName)) invalidArchive();

  const portable = rawName.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:/u.test(portable)) invalidArchive();

  const segments: string[] = [];
  for (const rawSegment of portable.split("/")) {
    if (rawSegment === "" || rawSegment === ".") continue;
    if (rawSegment === "..") invalidArchive();
    const segment = rawSegment.normalize("NFC");
    if (Buffer.byteLength(segment, "utf8") > MAX_PATH_SEGMENT_BYTES) invalidArchive();
    segments.push(segment);
  }

  if (segments.length === 0) invalidArchive();
  const canonical = segments.join("/");
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_PATH_BYTES) invalidArchive();
  return canonical;
}

function findEndOfCentralDirectory(view: DataView): number {
  if (view.byteLength < 22) invalidArchive();
  const minimum = Math.max(0, view.byteLength - 22 - MAX_ZIP_COMMENT_BYTES);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUint32(view, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentBytes = readUint16(view, offset + 20);
    if (offset + 22 + commentBytes === view.byteLength) return offset;
  }
  return invalidArchive();
}

function assertCompatibleEntryType(
  createdBySystem: number,
  externalAttributes: number,
  rawName: string,
  expandedSize: number,
): boolean {
  const unixType = (externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
  if (unixType === UNIX_SYMLINK_TYPE) invalidArchive();
  if (unixType !== 0 && unixType !== UNIX_REGULAR_TYPE && unixType !== UNIX_DIRECTORY_TYPE) {
    invalidArchive();
  }

  const trailingSlash = rawName.replaceAll("\\", "/").endsWith("/");
  const unixDirectory =
    (createdBySystem === 3 || createdBySystem === 19) && unixType === UNIX_DIRECTORY_TYPE;
  const dosDirectory = (externalAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0;
  const directory = trailingSlash || unixDirectory || dosDirectory;
  if (directory && expandedSize !== 0) invalidArchive();
  if (directory && !trailingSlash) invalidArchive();
  return directory;
}

function assertNoPathCollisions(entries: readonly CentralEntry[]): void {
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index]!;
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const other = entries[otherIndex]!;
      if (current.relativePath === other.relativePath) invalidArchive();
      if (!other.directory && current.relativePath.startsWith(`${other.relativePath}/`)) {
        invalidArchive();
      }
      if (!current.directory && other.relativePath.startsWith(`${current.relativePath}/`)) {
        invalidArchive();
      }
    }
  }
}

function assertLocalHeaders(
  archive: Uint8Array,
  view: DataView,
  centralDirectoryOffset: number,
  entries: readonly CentralEntry[],
): void {
  const ranges: { start: number; dataEnd: number }[] = [];

  for (const entry of entries) {
    const offset = entry.localHeaderOffset;
    if (offset + 30 > centralDirectoryOffset) invalidArchive();
    if (readUint32(view, offset) !== LOCAL_FILE_SIGNATURE) invalidArchive();

    const flags = readUint16(view, offset + 6);
    const compression = readUint16(view, offset + 8);
    const localCrc32 = readUint32(view, offset + 14);
    const localCompressedSize = readUint32(view, offset + 18);
    const localExpandedSize = readUint32(view, offset + 22);
    const nameLength = readUint16(view, offset + 26);
    const extraLength = readUint16(view, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart > centralDirectoryOffset || dataEnd > centralDirectoryOffset) invalidArchive();

    const localName = decodeZipName(archive.subarray(nameStart, nameStart + nameLength), flags);
    if (
      flags !== entry.flags ||
      compression !== entry.compression ||
      localName !== entry.rawName ||
      canonicalRelativePath(localName) !== entry.relativePath
    ) {
      invalidArchive();
    }

    if ((flags & DATA_DESCRIPTOR_FLAG) === 0) {
      if (
        localCrc32 !== entry.crc32 ||
        localCompressedSize !== entry.compressedSize ||
        localExpandedSize !== entry.expandedSize
      ) {
        invalidArchive();
      }
    } else if (
      (localCrc32 !== 0 && localCrc32 !== entry.crc32) ||
      (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize) ||
      (localExpandedSize !== 0 && localExpandedSize !== entry.expandedSize)
    ) {
      invalidArchive();
    }

    ranges.push({ start: offset, dataEnd });
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.dataEnd) invalidArchive();
  }
}

function readCentralDirectory(archive: Uint8Array, limits: ArchiveLimits): CentralEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  const diskNumber = readUint16(view, endOffset + 4);
  const centralDirectoryDisk = readUint16(view, endOffset + 6);
  const diskEntries = readUint16(view, endOffset + 8);
  const entryCount = readUint16(view, endOffset + 10);
  const centralDirectorySize = readUint32(view, endOffset + 12);
  const centralDirectoryOffset = readUint32(view, endOffset + 16);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    entryCount > limits.maxArchiveFiles ||
    centralDirectoryOffset + centralDirectorySize !== endOffset
  ) {
    invalidArchive();
  }

  const entries: CentralEntry[] = [];
  let expandedBytes = 0;
  let cursor = centralDirectoryOffset;
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralDirectoryEnd) invalidArchive();
    if (readUint32(view, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) invalidArchive();

    const createdBySystem = readUint16(view, cursor + 4) >>> 8;
    const flags = readUint16(view, cursor + 8);
    const compression = readUint16(view, cursor + 10);
    const crc32 = readUint32(view, cursor + 16);
    const compressedSize = readUint32(view, cursor + 20);
    const expandedSize = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const diskStart = readUint16(view, cursor + 34);
    const externalAttributes = readUint32(view, cursor + 38);
    const localHeaderOffset = readUint32(view, cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (nextCursor > centralDirectoryEnd || diskStart !== 0) invalidArchive();
    if ((flags & ENCRYPTION_FLAGS) !== 0 || (compression !== 0 && compression !== 8)) {
      invalidArchive();
    }
    if (expandedSize > limits.maxArchiveEntryBytes) invalidArchive();
    expandedBytes += expandedSize;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) {
      invalidArchive();
    }

    const nameStart = cursor + 46;
    const rawName = decodeZipName(archive.subarray(nameStart, nameStart + nameLength), flags);
    const relativePath = canonicalRelativePath(rawName);
    const directory = assertCompatibleEntryType(
      createdBySystem,
      externalAttributes,
      rawName,
      expandedSize,
    );

    entries.push({
      rawName,
      relativePath,
      compressedSize,
      expandedSize,
      compression,
      crc32,
      flags,
      localHeaderOffset,
      directory,
    });
    cursor = nextCursor;
  }

  if (cursor !== centralDirectoryEnd) invalidArchive();
  assertNoPathCollisions(entries);
  assertLocalHeaders(archive, view, centralDirectoryOffset, entries);
  return entries;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function calculateCrc32(chunks: readonly Buffer[]): number {
  let value = 0xffffffff;
  for (const chunk of chunks) {
    for (const byte of chunk) {
      value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function confinedPath(directory: string, relativePath: string): string {
  const absolutePath = resolve(directory, ...relativePath.split("/"));
  const fromDirectory = relative(directory, absolutePath);
  if (fromDirectory === "" || fromDirectory === ".." || fromDirectory.startsWith(`..${sep}`)) {
    invalidArchive();
  }
  if (isAbsolute(fromDirectory)) invalidArchive();
  return absolutePath;
}

async function extractEntries(
  archive: Uint8Array,
  directory: string,
  metadata: readonly CentralEntry[],
  limits: ArchiveLimits,
): Promise<ExtractedArchiveEntry[]> {
  const metadataByName = new Map(metadata.map((entry) => [entry.rawName, entry]));
  const observed = new Set<string>();
  const extracted: ExtractedArchiveEntry[] = [];
  const writes: Promise<void>[] = [];
  let expandedBytes = 0;
  let failure: unknown = null;

  const consume = (file: UnzipFile): void => {
    if (failure) return;
    const entry = metadataByName.get(file.name);
    if (!entry || observed.has(file.name) || file.compression !== entry.compression) {
      failure = invalidArchiveError();
      return;
    }
    observed.add(file.name);

    let entryBytes = 0;
    const chunks: Buffer[] = [];
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error || !chunk) {
        failure = invalidArchiveError();
        return;
      }

      const ownedChunk = Buffer.from(chunk);
      entryBytes += ownedChunk.byteLength;
      expandedBytes += ownedChunk.byteLength;
      if (
        entryBytes > entry.expandedSize ||
        entryBytes > limits.maxArchiveEntryBytes ||
        expandedBytes > limits.maxExpandedBytes
      ) {
        failure = invalidArchiveError();
        file.terminate();
        return;
      }
      if (ownedChunk.byteLength > 0) chunks.push(ownedChunk);

      if (!final) return;
      if (entryBytes !== entry.expandedSize || calculateCrc32(chunks) !== entry.crc32) {
        failure = invalidArchiveError();
        return;
      }

      const absolutePath = confinedPath(directory, entry.relativePath);
      if (entry.directory) {
        writes.push(mkdir(absolutePath, { recursive: true }).then(() => undefined));
        return;
      }

      const body = Buffer.concat(chunks, entryBytes);
      writes.push(
        mkdir(dirname(absolutePath), { recursive: true })
          .then(() => writeFile(absolutePath, body, { flag: "wx", mode: 0o600 }))
          .then(() => undefined),
      );
      extracted.push({ relativePath: entry.relativePath, absolutePath, sizeBytes: entryBytes });
    };

    try {
      file.start();
    } catch {
      failure = invalidArchiveError();
    }
  };

  try {
    const unzip = new Unzip(consume);
    unzip.register(UnzipInflate);
    unzip.push(archive, true);
  } catch {
    failure = invalidArchiveError();
  }

  const writeResults = await Promise.allSettled(writes);
  if (writeResults.some((result) => result.status === "rejected")) {
    failure = invalidArchiveError();
  }

  if (failure || observed.size !== metadata.length) invalidArchive();
  return extracted;
}

export class ArchiveReader {
  private readonly limits: ArchiveLimits;
  private readonly temporaryRoot: string;

  constructor(options: ArchiveReaderOptions = {}) {
    this.limits = resolveArchiveLimits(options.limits);
    this.temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
  }

  async readZip(archive: Uint8Array): Promise<ExtractedArchive> {
    if (!(archive instanceof Uint8Array) || archive.byteLength > this.limits.maxArchiveBytes) {
      invalidArchive();
    }

    const metadata = readCentralDirectory(archive, this.limits);
    const directory = await mkdtemp(join(this.temporaryRoot, "glyphquire-import-"));
    try {
      const entries = await extractEntries(archive, directory, metadata, this.limits);
      let cleaned = false;
      return {
        directory,
        entries,
        async cleanup() {
          if (cleaned) return;
          cleaned = true;
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch {
      await rm(directory, { recursive: true, force: true });
      return invalidArchive();
    }
  }

  read(archive: Uint8Array): Promise<ExtractedArchive> {
    return this.readZip(archive);
  }
}

export function readZipArchive(
  archive: Uint8Array,
  options: ArchiveReaderOptions = {},
): Promise<ExtractedArchive> {
  return new ArchiveReader(options).readZip(archive);
}
