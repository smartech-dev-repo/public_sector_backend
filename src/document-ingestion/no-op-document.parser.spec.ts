import { NoOpDocumentParser } from './no-op-document.parser';
import { DocumentUploadBatch } from '../generated/prisma/client';

describe('NoOpDocumentParser', () => {
  it('returns an all-zero result with no warnings', async () => {
    const parser = new NoOpDocumentParser();
    const result = await parser.parse({} as DocumentUploadBatch, Buffer.from(''));
    expect(result).toEqual({
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });
  });
});
