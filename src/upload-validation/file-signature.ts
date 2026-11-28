/**
 * What a file really is, from its first bytes ("magic bytes"), not from the name or the
 * Content-Type the uploader sent, which anyone can set to anything.
 */
export type DetectedType = 'jpeg' | 'png' | 'pdf' | 'xlsx' | 'csv';

/** What each type is called, so a claim can be compared with what the bytes say. */
export const TYPE_INFO: Record<
  DetectedType,
  {
    extensions: string[];
    mimeTypes: string[];
    canonicalMime: string;
    canonicalExtension: string;
    label: string;
  }
> = {
  jpeg: {
    extensions: ['jpg', 'jpeg', 'jfif'],
    mimeTypes: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
    canonicalMime: 'image/jpeg',
    canonicalExtension: 'jpg',
    label: 'JPEG',
  },
  png: {
    extensions: ['png'],
    mimeTypes: ['image/png', 'image/x-png'],
    canonicalMime: 'image/png',
    canonicalExtension: 'png',
    label: 'PNG',
  },
  pdf: {
    extensions: ['pdf'],
    mimeTypes: ['application/pdf', 'application/x-pdf'],
    canonicalMime: 'application/pdf',
    canonicalExtension: 'pdf',
    label: 'PDF',
  },
  xlsx: {
    extensions: ['xlsx'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      'application/x-zip-compressed',
    ],
    canonicalMime:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    canonicalExtension: 'xlsx',
    label: 'Excel (.xlsx)',
  },
  csv: {
    extensions: ['csv'],
    // Windows labels .csv as application/vnd.ms-excel when Excel is installed.
    mimeTypes: [
      'text/csv',
      'text/plain',
      'application/csv',
      'text/x-csv',
      'application/vnd.ms-excel',
      'text/comma-separated-values',
    ],
    canonicalMime: 'text/csv',
    canonicalExtension: 'csv',
    label: 'CSV',
  },
};

/** Content-Types that say nothing about the file. Sent by some phones, curl, and Windows without the matching app. */
export const GENERIC_MIME_TYPES = [
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
];

const startsWith = (buf: Buffer, bytes: number[], at = 0) =>
  buf.length >= at + bytes.length &&
  bytes.every((byte, i) => buf[at + i] === byte);

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const PDF = Buffer.from('%PDF-');

/**
 * Binary signatures only. CSV has none: it's recognised by the caller from the extension plus a
 * text check, and only when nothing here matched.
 */
export function detectBinaryType(
  buf: Buffer,
): Exclude<DetectedType, 'csv'> | null {
  if (startsWith(buf, JPEG)) return 'jpeg';
  if (startsWith(buf, PNG)) return 'png';
  // A ZIP is only an .xlsx if its entries say so; the spreadsheet inspector checks that.
  if (startsWith(buf, ZIP)) return 'xlsx';
  // Readers tolerate the header up to 1024 bytes in, but that lets a file start as HTML and still
  // pass as a PDF. Genuine PDFs start with it, so require byte 0.
  if (startsWith(buf, [...PDF])) return 'pdf';
  return null;
}
