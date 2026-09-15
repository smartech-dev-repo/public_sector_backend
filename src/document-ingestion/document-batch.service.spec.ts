import { DocumentBatchService } from './document-batch.service';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentBatchStatus, DocumentType } from '../generated/prisma/client';

describe('DocumentBatchService', () => {
  let service: DocumentBatchService;
  let prisma: {
    documentUploadBatch: {
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      documentUploadBatch: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };
    service = new DocumentBatchService(prisma as unknown as PrismaService);
  });

  it('createBatch stores the given fields with defaults applying via the schema', async () => {
    prisma.documentUploadBatch.create.mockResolvedValue({ id: 'batch-1' });

    await service.createBatch({
      documentType: DocumentType.IPPIS_BROADSHEET,
      uploadedById: 'admin-1',
      originalFileName: 'broadsheet.xlsx',
      storageKey: 'uploads/ippis_broadsheet/1.xlsx',
    });

    expect(prisma.documentUploadBatch.create).toHaveBeenCalledWith({
      data: {
        documentType: DocumentType.IPPIS_BROADSHEET,
        uploadedById: 'admin-1',
        originalFileName: 'broadsheet.xlsx',
        storageKey: 'uploads/ippis_broadsheet/1.xlsx',
        period: undefined,
      },
    });
  });

  it('markProcessing sets status PROCESSING and startedAt', async () => {
    await service.markProcessing('batch-1');
    expect(prisma.documentUploadBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { status: DocumentBatchStatus.PROCESSING, startedAt: expect.any(Date) },
    });
  });

  it('markCompleted sets status COMPLETED with the result counts', async () => {
    await service.markCompleted('batch-1', {
      rowsProcessed: 5,
      rowsCreated: 3,
      rowsUpdated: 2,
      rowsSkipped: 0,
      warnings: ['sheet X skipped'],
    });

    expect(prisma.documentUploadBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: {
        status: DocumentBatchStatus.COMPLETED,
        rowsProcessed: 5,
        rowsCreated: 3,
        rowsUpdated: 2,
        rowsSkipped: 0,
        warnings: ['sheet X skipped'],
        snapshotExportId: undefined,
        completedAt: expect.any(Date),
      },
    });
  });

  it('markFailed sets status FAILED with the error message', async () => {
    await service.markFailed('batch-1', 'parse error');
    expect(prisma.documentUploadBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { status: DocumentBatchStatus.FAILED, errorMessage: 'parse error', completedAt: expect.any(Date) },
    });
  });

  it('findById includes the snapshot export', async () => {
    prisma.documentUploadBatch.findUnique.mockResolvedValue({ id: 'batch-1' });
    await service.findById('batch-1');
    expect(prisma.documentUploadBatch.findUnique).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      include: { snapshotExport: true },
    });
  });

  it('list filters by documentType and status, ordered newest first', async () => {
    prisma.documentUploadBatch.findMany.mockResolvedValue([]);
    await service.list({ documentType: DocumentType.DISBURSED_LOANS, status: DocumentBatchStatus.COMPLETED });
    expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith({
      where: { documentType: DocumentType.DISBURSED_LOANS, status: DocumentBatchStatus.COMPLETED },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });
});
