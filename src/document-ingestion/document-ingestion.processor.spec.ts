import { Job } from 'bullmq';
import { DocumentIngestionProcessor, DocumentIngestionJobData } from './document-ingestion.processor';
import { DocumentBatchService } from './document-batch.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentParser } from './document-parser.interface';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { ClientLoanReconciliationService } from '../reconciliation/client-loan-reconciliation.service';
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
  let reconciliationService: { reconcileAll: jest.Mock };
  let clientLoanReconciliationService: { reconcileAll: jest.Mock };

  beforeEach(() => {
    documentBatchService = {
      findById: jest.fn(),
      markProcessing: jest.fn(),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    fileStorageProvider = { getObject: jest.fn() };
    parsers = {
      [DocumentType.IPPIS_BROADSHEET]: { parse: jest.fn() },
      [DocumentType.DISBURSED_LOANS]: { parse: jest.fn() },
      [DocumentType.REPAYMENT_SCHEDULE]: { parse: jest.fn() },
    };
    reconciliationService = { reconcileAll: jest.fn().mockResolvedValue(undefined) };
    clientLoanReconciliationService = { reconcileAll: jest.fn().mockResolvedValue(undefined) };
    processor = new DocumentIngestionProcessor(
      documentBatchService as unknown as DocumentBatchService,
      fileStorageProvider as unknown as FileStorageProvider,
      parsers as unknown as Record<DocumentType, DocumentParser>,
      reconciliationService as unknown as ReconciliationService,
      clientLoanReconciliationService as unknown as ClientLoanReconciliationService,
    );
  });

  it('logs and returns early when the batch is not found', async () => {
    documentBatchService.findById.mockResolvedValue(null);
    await processor.process({ data: { batchId: 'missing' } } as Job<DocumentIngestionJobData>);
    expect(documentBatchService.markProcessing).not.toHaveBeenCalled();
  });

  it('marks processing, dispatches to the matching parser, and marks completed on success, without running reconciliation for IPPIS_BROADSHEET', async () => {
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
    expect(reconciliationService.reconcileAll).not.toHaveBeenCalled();
    expect(clientLoanReconciliationService.reconcileAll).not.toHaveBeenCalled();
    expect(documentBatchService.markCompleted).toHaveBeenCalledWith('batch-1', {
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });
  });

  it('runs reconciliation after a successful DISBURSED_LOANS parse', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-2',
      documentType: DocumentType.DISBURSED_LOANS,
      storageKey: 'uploads/loans.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.DISBURSED_LOANS].parse.mockResolvedValue({
      rowsProcessed: 1,
      rowsCreated: 1,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });

    await processor.process({ data: { batchId: 'batch-2' } } as Job<DocumentIngestionJobData>);

    expect(reconciliationService.reconcileAll).toHaveBeenCalledTimes(1);
    expect(clientLoanReconciliationService.reconcileAll).toHaveBeenCalledTimes(1);
    expect(documentBatchService.markCompleted).toHaveBeenCalled();
  });

  it('runs reconciliation after a successful REPAYMENT_SCHEDULE parse', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-3',
      documentType: DocumentType.REPAYMENT_SCHEDULE,
      storageKey: 'uploads/repayments.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.REPAYMENT_SCHEDULE].parse.mockResolvedValue({
      rowsProcessed: 1,
      rowsCreated: 1,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });

    await processor.process({ data: { batchId: 'batch-3' } } as Job<DocumentIngestionJobData>);

    expect(reconciliationService.reconcileAll).toHaveBeenCalledTimes(1);
    expect(clientLoanReconciliationService.reconcileAll).toHaveBeenCalledTimes(1);
  });

  it('marks failed with the error message when the parser throws, without running reconciliation', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-1',
      documentType: DocumentType.IPPIS_BROADSHEET,
      storageKey: 'uploads/file.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.IPPIS_BROADSHEET].parse.mockRejectedValue(new Error('bad file'));

    await processor.process({ data: { batchId: 'batch-1' } } as Job<DocumentIngestionJobData>);

    expect(documentBatchService.markFailed).toHaveBeenCalledWith('batch-1', 'bad file');
    expect(reconciliationService.reconcileAll).not.toHaveBeenCalled();
    expect(clientLoanReconciliationService.reconcileAll).not.toHaveBeenCalled();
  });
});
