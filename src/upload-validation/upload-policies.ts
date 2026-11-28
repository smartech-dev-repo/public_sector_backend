import { DetectedType } from './file-signature';

/** What one kind of upload accepts. Every upload route names one of these. */
export interface UploadPolicy {
  name: string;
  types: DetectedType[];
  maxBytes: number;
  /** Images only: decoded width × height. Stops "decompression bombs" (tiny files that decode to huge images). */
  maxPixels?: number;
  /** Images only: store every accepted image in this format (e.g. a PNG selfie becomes a JPEG). */
  convertImagesTo?: 'jpeg';
}

const MB = 1024 * 1024;

/** Selfies, passport photos, profile pictures. Stored as JPEG whatever was uploaded. */
export const PHOTO: UploadPolicy = {
  name: 'photo',
  types: ['jpeg', 'png'],
  maxBytes: 5 * MB,
  maxPixels: 40_000_000,
  convertImagesTo: 'jpeg',
};

/** Client onboarding documents and the agent applicant's ID document. */
export const KYC_DOCUMENT: UploadPolicy = {
  name: 'kyc-document',
  types: ['jpeg', 'png', 'pdf'],
  maxBytes: 5 * MB,
  maxPixels: 40_000_000,
};

/** Proof attached when an admin releases a device. */
export const PROOF: UploadPolicy = {
  name: 'proof',
  types: ['jpeg', 'png', 'pdf'],
  maxBytes: 5 * MB,
  maxPixels: 40_000_000,
};

/** Agent applicant's CV. PDF only. */
export const CV: UploadPolicy = {
  name: 'cv',
  types: ['pdf'],
  maxBytes: 5 * MB,
};

/** IPPIS broadsheets, disbursed loans, repayment schedules. */
export const SPREADSHEET: UploadPolicy = {
  name: 'spreadsheet',
  types: ['xlsx', 'csv'],
  maxBytes: 50 * MB,
};

/** Multer limits to pair with a policy, so oversized bodies stop before they're buffered. */
export const multerLimits = (policy: UploadPolicy, files = 1) => ({
  fileSize: policy.maxBytes,
  files,
  fields: 20,
  parts: 40,
});
