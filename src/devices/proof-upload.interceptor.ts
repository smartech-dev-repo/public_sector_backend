import { BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PROOF_TYPES } from './device-release.service';

/** Optional multipart field "proof": JPEG, PNG or PDF up to 5 MB. */
export const ProofUpload = () =>
  FileInterceptor('proof', {
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (
      _req: Express.Request,
      file: Express.Multer.File,
      callback: (error: Error | null, accept: boolean) => void,
    ) => {
      if (!PROOF_TYPES.includes(file.mimetype)) {
        callback(
          new BadRequestException('Proof must be a JPEG, PNG or PDF file'),
          false,
        );
        return;
      }
      callback(null, true);
    },
  });
