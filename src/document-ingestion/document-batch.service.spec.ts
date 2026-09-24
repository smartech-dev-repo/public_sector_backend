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
      count: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      documentUploadBatch: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
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

  it('findById includes the snapshot export and uploadedBy', async () => {
    prisma.documentUploadBatch.findUnique.mockResolvedValue({ id: 'batch-1' });
    await service.findById('batch-1');
    expect(prisma.documentUploadBatch.findUnique).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      include: {
        snapshotExport: true,
        uploadedBy: { select: { id: true, fullName: true, email: true } },
      },
    });
  });

  describe('list', () => {
    it('filters by documentType and status, ordered newest first, defaulting to page 1/limit 25', async () => {
      prisma.documentUploadBatch.findMany.mockResolvedValue([]);
      prisma.documentUploadBatch.count.mockResolvedValue(0);

      const result = await service.list({ documentType: DocumentType.DISBURSED_LOANS, status: DocumentBatchStatus.COMPLETED });

      expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith({
        where: {
          documentType: DocumentType.DISBURSED_LOANS,
          status: DocumentBatchStatus.COMPLETED,
          createdAt: undefined,
          completedAt: undefined,
          OR: undefined,
        },
        include: {
          uploadedBy: { select: { id: true, fullName: true, email: true } },
          snapshotExport: { select: { id: true, documentType: true, generatedAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 25,
      });
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('searches originalFileName and period', async () => {
      prisma.documentUploadBatch.findMany.mockResolvedValue([]);
      prisma.documentUploadBatch.count.mockResolvedValue(0);

      await service.list({ q: '2026-01' });

      expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { originalFileName: { contains: '2026-01', mode: 'insensitive' } },
              { period: { contains: '2026-01', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies createdAt and completedAt date ranges independently', async () => {
      prisma.documentUploadBatch.findMany.mockResolvedValue([]);
      prisma.documentUploadBatch.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const completedTo = new Date('2025-06-01');

      await service.list({ createdFrom, completedTo });

      expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: createdFrom, lte: undefined },
            completedAt: { gte: undefined, lte: completedTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.documentUploadBatch.findMany.mockResolvedValue([]);
      prisma.documentUploadBatch.count.mockResolvedValue(12);

      const result = await service.list({}, { page: 2, limit: 5 });

      expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
      expect(result.meta).toEqual({ total: 12, page: 2, limit: 5, totalPages: 3 });
    });
  });
});
