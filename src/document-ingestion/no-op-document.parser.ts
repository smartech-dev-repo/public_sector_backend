import { Injectable } from '@nestjs/common';
import { DocumentParser, ParseResult } from './document-parser.interface';
import { DocumentUploadBatch } from '../generated/prisma/client';

@Injectable()
export class NoOpDocumentParser implements DocumentParser {
  async parse(_batch: DocumentUploadBatch, _fileBuffer: Buffer): Promise<ParseResult> {
    return { rowsProcessed: 0, rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 0, warnings: [] };
  }
}
