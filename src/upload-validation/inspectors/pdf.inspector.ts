import { inflateSync } from 'zlib';
import { InspectionFailure } from './inspection-failure';

/**
 * PDF features that run code, open other programs, carry other files or send data. None of them
 * has a place in a KYC document, proof or CV, so a PDF containing any of them is refused.
 */
const DANGEROUS_NAMES = [
  'JavaScript',
  'JS',
  'Launch',
  'EmbeddedFile',
  'EmbeddedFiles',
  'RichMedia',
  'XFA',
  'SubmitForm',
  'ImportData',
  'GoToE',
];
const DANGEROUS = new RegExp(
  `/(?:${DANGEROUS_NAMES.join('|')})(?=[\\s/<>\\[\\]()%{}]|$)`,
);

/** Upper bound on decompressed stream data scanned per file, so a compression bomb can't exhaust memory. */
const MAX_INFLATED_BYTES = 100 * 1024 * 1024;

const UNREADABLE =
  "The PDF couldn't be read. It may be damaged or incomplete; export it again.";
const DANGEROUS_MESSAGE =
  'This PDF contains scripts, attachments or interactive content, which are not accepted. Print or export it to a new PDF and upload that.';

/**
 * PDF names may hide letters as #xx hex escapes ("/J#61vaScript" is "/JavaScript"). Decode them in
 * names only, so the scan sees what a PDF reader would.
 */
const decodeNames = (text: string) =>
  text.replace(/\/[^\s/<>[\]()%{}]+/g, (name) =>
    name.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
  );

/** Structure checks plus a scan for dangerous content, including inside compressed streams. */
export function inspectPdf(buffer: Buffer): void {
  const tail = buffer
    .subarray(Math.max(0, buffer.length - 2048))
    .toString('latin1');
  if (!tail.includes('%%EOF') || !tail.includes('startxref')) {
    throw new InspectionFailure('undecodable', UNREADABLE);
  }

  const text = buffer.toString('latin1');
  if (/\/Encrypt(?=[\s/<>[\]()%{}]|$)/.test(decodeNames(text))) {
    throw new InspectionFailure(
      'undecodable',
      'Password-protected PDFs are not accepted. Remove the password and upload it again.',
    );
  }
  if (DANGEROUS.test(decodeNames(text))) {
    throw new InspectionFailure('dangerous-content', DANGEROUS_MESSAGE);
  }

  // Object streams and content streams are usually Flate-compressed, and names inside them don't
  // appear in the raw bytes. Inflate each stream and scan it too.
  let inflatedTotal = 0;
  const streamStart = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamStart.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = text.indexOf('endstream', bodyStart);
    if (bodyEnd === -1) break;
    streamStart.lastIndex = bodyEnd;

    let inflated: Buffer;
    try {
      inflated = inflateSync(buffer.subarray(bodyStart, bodyEnd), {
        maxOutputLength: MAX_INFLATED_BYTES - inflatedTotal + 1,
      });
    } catch (error) {
      if (
        error instanceof RangeError ||
        (error as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE'
      ) {
        throw new InspectionFailure('dangerous-content', DANGEROUS_MESSAGE);
      }
      continue; // Not Flate (an image, or another filter): nothing to scan for names.
    }
    inflatedTotal += inflated.length;
    if (inflatedTotal > MAX_INFLATED_BYTES) {
      throw new InspectionFailure('dangerous-content', DANGEROUS_MESSAGE);
    }
    if (DANGEROUS.test(decodeNames(inflated.toString('latin1')))) {
      throw new InspectionFailure('dangerous-content', DANGEROUS_MESSAGE);
    }
  }
}
