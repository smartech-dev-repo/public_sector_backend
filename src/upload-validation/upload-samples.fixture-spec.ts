/**
 * Sample uploads built in memory for the upload-validation specs. Not a test file itself (Jest runs
 * *.spec.ts) and excluded from the build (*spec.ts). Never put real customer documents here.
 */
import { Workbook } from 'exceljs';
import { crc32, deflateRawSync, deflateSync } from 'zlib';
import { sharp } from './sharp';

export const multerFile = (
  buffer: Buffer,
  originalname: string,
  mimetype: string,
): Express.Multer.File =>
  ({
    buffer,
    originalname,
    mimetype,
    size: buffer.length,
    fieldname: 'file',
    encoding: '7bit',
  }) as Express.Multer.File;

export const jpeg = (width = 64, height = 48) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 120, b: 80 },
    },
  })
    .jpeg()
    .toBuffer();

export const png = (width = 64, height = 48) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 120, b: 80 },
    },
  })
    .png()
    .toBuffer();

/** Minimal, well-formed PDF. `catalogExtra` is spliced into the catalog dictionary. */
export const pdf = (catalogExtra = '') =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R${catalogExtra}>>\nendobj\n2 0 obj\n<</Type/Pages/Kids[]/Count 0>>\nendobj\nxref\n0 3\ntrailer\n<</Size 3/Root 1 0 R>>\nstartxref\n120\n%%EOF\n`,
    'latin1',
  );

/** PDF whose only dangerous content is inside a Flate-compressed stream. */
export const pdfWithCompressedStream = (content: string) => {
  const body = deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.5\n3 0 obj\n<</Type/ObjStm/Length ${body.length}/Filter/FlateDecode>>\nstream\n`,
      'latin1',
    ),
    body,
    Buffer.from('\nendstream\nendobj\nstartxref\n9\n%%EOF\n', 'latin1'),
  ]);
};

export async function xlsx(): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.addWorksheet('Sheet1').addRows([
    ['Staff ID', 'Name'],
    ['IP001', 'Test Person'],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Tiny ZIP writer for hostile archives exceljs won't produce. `declaredSize` lets a test lie about an entry's size. */
export function zip(
  entries: {
    name: string;
    data: Buffer;
    declaredSize?: number;
    encrypted?: boolean;
  }[],
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const size = entry.declaredSize ?? entry.data.length;
    const crc = crc32(entry.data);
    const flags = entry.encrypted ? 0x1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** The two parts that make a ZIP look like an .xlsx, plus whatever else a test adds. */
export const xlsxParts = (
  extra: {
    name: string;
    data: Buffer;
    declaredSize?: number;
    encrypted?: boolean;
  }[] = [],
  contentTypes = '<Types/>',
) =>
  zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
    ...extra,
  ]);
