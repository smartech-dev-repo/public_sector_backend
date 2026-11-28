import { FileInterceptor } from '@nestjs/platform-express';
import { PROOF, multerLimits } from '../upload-validation/upload-policies';

/**
 * Optional multipart field "proof": JPEG, PNG or PDF up to 5 MB. Multer only caps the size; pair it
 * with `@UploadedFile(new ValidateUpload(PROOF, 'proof'))`, which checks what the file really is.
 */
export const ProofUpload = () =>
  FileInterceptor('proof', { limits: multerLimits(PROOF) });
