import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DocumentBatchService } from './document-batch.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentBatchStatus, DocumentType } from '../generated/prisma/client';

describe('DocumentBatchService review', () => {
  let prisma: { documentUploadBatch: { findUnique: jest.Mock; updateMany: jest.Mock } };
  let storage: { deleteObject: jest.Mock };
  let service: DocumentBatchService;
  const batch = {
    id: 'b1',
    documentType: DocumentType.IPPIS_BROADSHEET,
    status: DocumentBatchStatus.AWAITING_CONFIRMATION,
    storageKey: 'uploads/x.xlsx',
    analysis: { verdict: 'READY' },
  };

  beforeEach(() => {
    prisma = { documentUploadBatch: { findUnique: jest.fn().mockResolvedValue(batch), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    storage = { deleteObject: jest.fn() };
    service = new DocumentBatchService(prisma as unknown as PrismaService, storage as unknown as FileStorageProvider);
  });

  it('confirms by moving the batch to PENDING only from AWAITING_CONFIRMATION', async () => {
    await service.confirm('b1', DocumentType.IPPIS_BROADSHEET);
    expect(prisma.documentUploadBatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', status: DocumentBatchStatus.AWAITING_CONFIRMATION },
      data: expect.objectContaining({ status: DocumentBatchStatus.PENDING }),
    });
  });

  it('loses a confirm race with a conflict', async () => {
    prisma.documentUploadBatch.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.confirm('b1', DocumentType.IPPIS_BROADSHEET)).rejects.toThrow(ConflictException);
  });

  it('refuses to merge a file that failed review', async () => {
    prisma.documentUploadBatch.findUnique.mockResolvedValue({ ...batch, analysis: { verdict: 'REUPLOAD_REQUIRED' } });
    await expect(service.confirm('b1', DocumentType.IPPIS_BROADSHEET)).rejects.toThrow(UnprocessableEntityException);
    expect(prisma.documentUploadBatch.updateMany).not.toHaveBeenCalled();
  });

  it('treats a batch of another document type as not found, so one upload permission cannot act on another', async () => {
    await expect(service.confirm('b1', DocumentType.DISBURSED_LOANS)).rejects.toThrow(NotFoundException);
  });

  it('cancels and removes the stored file', async () => {
    await service.cancel('b1', DocumentType.IPPIS_BROADSHEET);
    expect(storage.deleteObject).toHaveBeenCalledWith('uploads/x.xlsx');
  });
});
