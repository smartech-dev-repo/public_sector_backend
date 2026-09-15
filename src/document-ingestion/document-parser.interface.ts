import { DocumentUploadBatch } from '../generated/prisma/client';
import { BatchResult } from './document-batch.service';

export const DOCUMENT_PARSERS = Symbol('DOCUMENT_PARSERS');

// Same shape DocumentBatchService.markCompleted() consumes (Task 4) — aliased
// here under the name that reads naturally at a parser's call site. Kept as
// one canonical declaration (BatchResult) rather than two structurally-equal
// interfaces that only happened to line up.
export type ParseResult = BatchResult;

export interface DocumentParser {
  parse(batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<ParseResult>;
}
