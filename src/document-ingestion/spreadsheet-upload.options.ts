import { BadRequestException } from '@nestjs/common';
import { extname } from 'path';

export const MAX_SPREADSHEET_BYTES = 50 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ['.xlsx', '.csv'];

export const SPREADSHEET_UPLOAD_OPTIONS = {
  limits: { fileSize: MAX_SPREADSHEET_BYTES },
  fileFilter: (
    _req: Express.Request,
    file: Express.Multer.File,
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!ACCEPTED_EXTENSIONS.includes(extname(file.originalname).toLowerCase())) {
      callback(new BadRequestException('Only .xlsx or .csv files are allowed'), false);
      return;
    }
    callback(null, true);
  },
};
