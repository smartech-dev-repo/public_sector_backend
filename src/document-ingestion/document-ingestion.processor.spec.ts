import { Job } from 'bullmq';
import { DocumentIngestionProcessor, DocumentIngestionJobData } from './document-ingestion.processor';
import { DocumentBatchService } from './document-batch.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentParser } from './document-parser.interface';
import { DocumentType } from '../generated/prisma/client';

describe('DocumentIngestionProcessor', () => {
  let processor: DocumentIngestionProcessor;
  let documentBatchService: {
    findById: jest.Mock;
    markProcessing: jest.Mock;
    markCompleted: jest.Mock;
    markFailed: jest.Mock;
  };
  let fileStorageProvider: { getObject: jest.Mock };
  let parsers: Record<string, { parse: jest.Mock }>;

  beforeEach(() => {
    documentBatchService = {
      findById: jest.fn(),
      markProcessing: jest.fn(),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    fileStorageProvider = { getObject: jest.fn() };
    parsers = { [DocumentType.IPPIS_BROADSHEET]: { parse: jest.fn() } };
    processor = new DocumentIngestionProcessor(
      documentBatchService as unknown as DocumentBatchService,
      fileStorageProvider as unknown as FileStorageProvider,
      parsers as unknown as Record<DocumentType, DocumentParser>,
    );
  });

  it('logs and returns early when the batch is not found', async () => {
    documentBatchService.findById.mockResolvedValue(null);
    await processor.process({ data: { batchId: 'missing' } } as Job<DocumentIngestionJobData>);
    expect(documentBatchService.markProcessing).not.toHaveBeenCalled();
  });

  it('marks processing, dispatches to the matching parser, and marks completed on success', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-1',
      documentType: DocumentType.IPPIS_BROADSHEET,
      storageKey: 'uploads/file.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.IPPIS_BROADSHEET].parse.mockResolvedValue({
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });

    await processor.process({ data: { batchId: 'batch-1' } } as Job<DocumentIngestionJobData>);

    expect(documentBatchService.markProcessing).toHaveBeenCalledWith('batch-1');
    expect(parsers[DocumentType.IPPIS_BROADSHEET].parse).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'batch-1' }),
      Buffer.from('fake-file'),
    );
    expect(documentBatchService.markCompleted).toHaveBeenCalledWith('batch-1', {
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });
  });

  it('marks failed with the error message when the parser throws', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-1',
      documentType: DocumentType.IPPIS_BROADSHEET,
      storageKey: 'uploads/file.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.IPPIS_BROADSHEET].parse.mockRejectedValue(new Error('bad file'));

    await processor.process({ data: { batchId: 'batch-1' } } as Job<DocumentIngestionJobData>);

    expect(documentBatchService.markFailed).toHaveBeenCalledWith('batch-1', 'bad file');
  });
});
