import { PipeTransform } from '@nestjs/common';
import { createHash } from 'crypto';
import { extname } from 'path';
import {
  DetectedType,
  GENERIC_MIME_TYPES,
  TYPE_INFO,
  detectBinaryType,
} from './file-signature';
import { InspectionFailure } from './inspectors/inspection-failure';
import { inspectImage } from './inspectors/image.inspector';
import { inspectPdf } from './inspectors/pdf.inspector';
import { inspectCsv, inspectXlsx } from './inspectors/spreadsheet.inspector';
import { UploadPolicy } from './upload-policies';
import { UploadRejectedException } from './upload-rejected.exception';

/**
 * A file that passed its policy. `buffer`, `mimetype` and `originalname` describe what to store:
 * re-encoded for images (and converted if the policy says so), as uploaded otherwise.
 */
export interface ValidatedFile extends Express.Multer.File {
  /** What the upload really was. */
  detectedType: DetectedType;
  /** SHA-256 of the stored bytes, for the audit trail and duplicate checks. */
  sha256: string;
}

const accepted = (policy: UploadPolicy) =>
  policy.types
    .map((type) => TYPE_INFO[type].label)
    .join(', ')
    .replace(/, ([^,]*)$/, ' or $1');
const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Display name only: no path, no control characters, no extension (the real one is added), capped length. */
function safeBaseName(originalname: string): string {
  const base = (originalname.split(/[\\/]/).pop() ?? '').replace(
    /\.[^.]*$/,
    '',
  );
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || 'upload';
}

/**
 * Decides what the file really is from its bytes, checks it against the policy and refuses
 * anything else. Throws UploadRejectedException; the caller stores nothing in that case.
 */
export async function validateUpload(
  file: Express.Multer.File,
  policy: UploadPolicy,
  field: string,
): Promise<ValidatedFile> {
  const claimedType = (file.mimetype ?? '').toLowerCase();
  const claimedExtension = extname(file.originalname ?? '')
    .slice(1)
    .toLowerCase();
  const reject = (
    reason: ConstructorParameters<typeof UploadRejectedException>[1]['reason'],
    message: string,
    detectedType = 'unknown',
  ): never => {
    throw new UploadRejectedException(message, {
      reason,
      field,
      policy: policy.name,
      claimedType,
      detectedType,
      size: file.size,
    });
  };

  if (file.size > policy.maxBytes || file.buffer.length > policy.maxBytes) {
    reject(
      'too-large',
      `The file is larger than ${megabytes(policy.maxBytes)}.`,
    );
  }
  const wrongType = `Only ${accepted(policy)} files are accepted.`;

  // CSV has no signature: it's only considered when no binary signature matched and the name says .csv.
  let detected: DetectedType | null = detectBinaryType(file.buffer);
  if (!detected && claimedExtension === 'csv' && policy.types.includes('csv'))
    detected = 'csv';
  if (!detected || !policy.types.includes(detected)) {
    return reject('type-mismatch', wrongType, detected ?? 'unknown');
  }

  // A claim that's missing (no extension, a generic Content-Type) is fine: the bytes decide.
  // A claim that contradicts the bytes is a disguised file.
  const info = TYPE_INFO[detected];
  if (claimedExtension && !info.extensions.includes(claimedExtension))
    reject('type-mismatch', wrongType, detected);
  if (
    !GENERIC_MIME_TYPES.includes(claimedType) &&
    !info.mimeTypes.includes(claimedType)
  )
    reject('type-mismatch', wrongType, detected);

  let buffer = file.buffer;
  // What's stored: the same type, unless the policy converts images (PNG selfie → JPEG).
  const storedType: DetectedType =
    (detected === 'jpeg' || detected === 'png') && policy.convertImagesTo
      ? policy.convertImagesTo
      : detected;
  try {
    if (detected === 'jpeg' || detected === 'png') {
      buffer = await inspectImage(
        file.buffer,
        detected,
        policy.maxPixels ?? 40_000_000,
        storedType as 'jpeg' | 'png',
      );
    } else if (detected === 'pdf') inspectPdf(file.buffer);
    else if (detected === 'xlsx') await inspectXlsx(file.buffer);
    else inspectCsv(file.buffer);
  } catch (error) {
    if (error instanceof InspectionFailure)
      reject(error.reason, error.message, detected);
    throw error;
  }

  const stored = TYPE_INFO[storedType];
  return {
    ...file,
    buffer,
    size: buffer.length,
    mimetype: stored.canonicalMime,
    originalname: `${safeBaseName(file.originalname ?? '')}.${stored.canonicalExtension}`,
    detectedType: detected,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/** `@UploadedFile(new ValidateUpload(PHOTO))`. A missing file passes through, so the controller's own "is required" check still applies. */
export class ValidateUpload implements PipeTransform<
  Express.Multer.File | undefined,
  Promise<ValidatedFile | undefined>
> {
  constructor(
    private readonly policy: UploadPolicy,
    private readonly field = 'file',
  ) {}

  async transform(
    file: Express.Multer.File | undefined,
  ): Promise<ValidatedFile | undefined> {
    return file ? validateUpload(file, this.policy, this.field) : undefined;
  }
}

/** `@UploadedFiles(new ValidateUploads({ cv: CV, passportPhoto: PHOTO }))` for multi-field uploads. */
export class ValidateUploads implements PipeTransform<
  Record<string, Express.Multer.File[]> | undefined,
  Promise<Record<string, ValidatedFile[]>>
> {
  constructor(private readonly policies: Record<string, UploadPolicy>) {}

  async transform(
    files: Record<string, Express.Multer.File[]> | undefined,
  ): Promise<Record<string, ValidatedFile[]>> {
    const result: Record<string, ValidatedFile[]> = {};
    for (const [field, list] of Object.entries(files ?? {})) {
      const policy = this.policies[field];
      if (!policy) {
        throw new UploadRejectedException('Unexpected file field.', {
          reason: 'type-mismatch',
          field,
          policy: 'none',
          claimedType: list[0]?.mimetype ?? '',
          detectedType: 'unknown',
          size: list[0]?.size ?? 0,
        });
      }
      result[field] = [];
      for (const file of list)
        result[field].push(await validateUpload(file, policy, field));
    }
    return result;
  }
}
