import { SPREADSHEET, multerLimits } from '../upload-validation/upload-policies';

export const MAX_SPREADSHEET_BYTES = SPREADSHEET.maxBytes;

/**
 * Multer only caps the size. What the file really is (.xlsx or CSV, from its bytes) is checked by
 * `@UploadedFile(new ValidateUpload(SPREADSHEET))` on each route.
 */
export const SPREADSHEET_UPLOAD_OPTIONS = { limits: multerLimits(SPREADSHEET) };
