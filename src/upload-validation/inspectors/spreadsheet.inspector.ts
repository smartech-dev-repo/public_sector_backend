import { promisify } from 'util';
import { inflateRaw } from 'zlib';
import { InspectionFailure } from './inspection-failure';

const inflateRawAsync = promisify(inflateRaw) as (
  buf: Buffer,
  options: { maxOutputLength: number },
) => Promise<Buffer>;

const MAX_ENTRIES = 10_000;
/** Total size once unzipped. A 50 MB .xlsx of IPPIS rows is well under this; a zip bomb isn't. */
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
/** Spreadsheet XML compresses well, but not this well; beyond it an entry is a bomb. */
const MAX_RATIO = 200;

const NOT_XLSX =
  'This isn\'t a valid Excel (.xlsx) file. Save it from Excel as "Excel Workbook (.xlsx)" and upload it again.';
const MACROS =
  'Excel files with macros or embedded objects are not accepted. Save it as a plain "Excel Workbook (.xlsx)".';

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Reads the ZIP central directory: names and declared sizes of every entry, without unzipping anything. */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment (max 65535).
  const searchFrom = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new InspectionFailure('undecodable', NOT_XLSX);

  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 markers: far beyond any genuine spreadsheet upload here.
  if (count === 0xffff || dirOffset === 0xffffffff || dirSize === 0xffffffff) {
    throw new InspectionFailure('undecodable', NOT_XLSX);
  }
  if (count > MAX_ENTRIES)
    throw new InspectionFailure('dangerous-content', NOT_XLSX);
  if (dirOffset + dirSize > buf.length)
    throw new InspectionFailure('undecodable', NOT_XLSX);

  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new InspectionFailure('undecodable', NOT_XLSX);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    entries.push({
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      localHeaderOffset: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nameLength),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Unzips one entry, refusing to produce more than it declared (a lying header is a bomb). */
async function readEntry(buf: Buffer, entry: ZipEntry): Promise<Buffer> {
  const at = entry.localHeaderOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50)
    throw new InspectionFailure('undecodable', NOT_XLSX);
  const dataStart =
    at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new InspectionFailure('undecodable', NOT_XLSX);
  try {
    return await inflateRawAsync(data, {
      maxOutputLength: Math.max(1, entry.uncompressedSize),
    });
  } catch {
    throw new InspectionFailure('dangerous-content', NOT_XLSX);
  }
}

/** A real .xlsx: the right parts, no macros or embedded programs, and no zip bomb. */
export async function inspectXlsx(buffer: Buffer): Promise<void> {
  const entries = readCentralDirectory(buffer);
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    throw new InspectionFailure('type-mismatch', NOT_XLSX);
  }

  let total = 0;
  for (const entry of entries) {
    if (entry.flags & 0x1)
      throw new InspectionFailure(
        'undecodable',
        'Password-protected Excel files are not accepted. Remove the password and upload it again.',
      );
    if (
      /(^|\/)vbaProject\.bin$/i.test(entry.name) ||
      /^xl\/(activeX|embeddings)\//i.test(entry.name)
    ) {
      throw new InspectionFailure('dangerous-content', MACROS);
    }
    total += entry.uncompressedSize;
    if (total > MAX_UNCOMPRESSED_BYTES)
      throw new InspectionFailure('dangerous-content', NOT_XLSX);
    if (
      entry.uncompressedSize > 1024 * 1024 &&
      entry.uncompressedSize > entry.compressedSize * MAX_RATIO
    ) {
      throw new InspectionFailure('dangerous-content', NOT_XLSX);
    }
  }

  // Each entry must really be the size it claims; this also proves the archive unzips.
  for (const entry of entries) {
    const data = await readEntry(buffer, entry);
    if (data.length !== entry.uncompressedSize)
      throw new InspectionFailure('undecodable', NOT_XLSX);
    if (
      entry.name === '[Content_Types].xml' &&
      /macroEnabled/i.test(data.toString('utf8'))
    ) {
      throw new InspectionFailure('dangerous-content', MACROS);
    }
  }
}

/**
 * CSV has no signature, so check it's text: no NUL bytes and almost no control characters. The
 * parser decodes it as before; this only keeps binaries and disguised files out.
 */
export function inspectCsv(buffer: Buffer): void {
  const notText =
    'This isn\'t a CSV text file. Save it from Excel as "CSV (Comma delimited)" and upload it again.';
  if (buffer.length === 0) throw new InspectionFailure('undecodable', notText);
  const sample = buffer.subarray(0, 64 * 1024);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) throw new InspectionFailure('type-mismatch', notText);
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)
      control++;
  }
  if (control > sample.length * 0.01)
    throw new InspectionFailure('type-mismatch', notText);
}
