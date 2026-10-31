import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentBatchStatus, DocumentType, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentAnalysis } from './analysis/analysis-builder';

export interface CreateBatchParams {
  documentType: DocumentType;
  uploadedById: string;
  originalFileName: string;
  sheetName?: string;
  storedFileName?: string;
  fileSizeBytes?: number;
  storageKey: string;
  period?: string;
  status?: DocumentBatchStatus;
}

export interface BatchResult {
  rowsProcessed: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsSkipped: number;
  warnings: string[];
  snapshotExportId?: string;
}

export interface ListBatchesFilters {
  documentType?: DocumentType;
  status?: DocumentBatchStatus;
  q?: string;
  period?: string;
  createdFrom?: Date;
  createdTo?: Date;
  completedFrom?: Date;
  completedTo?: Date;
}

@Injectable()
export class DocumentBatchService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async createBatch(params: CreateBatchParams) {
    return this.prisma.documentUploadBatch.create({
      data: {
        documentType: params.documentType,
        uploadedById: params.uploadedById,
        originalFileName: params.originalFileName,
        sheetName: params.sheetName,
        storedFileName: params.storedFileName,
        fileSizeBytes: params.fileSizeBytes,
        storageKey: params.storageKey,
        period: params.period,
        status: params.status,
      },
    });
  }

  async markAnalyzed(batchId: string, analysis: DocumentAnalysis): Promise<void> {
    await this.prisma.documentUploadBatch.update({
      where: { id: batchId },
      data: {
        status: DocumentBatchStatus.AWAITING_CONFIRMATION,
        analysis: analysis as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // The status check is part of the write so a double-click on "Merge" can
  // only ever enqueue one merge.
  async confirm(batchId: string, documentType: DocumentType) {
    const batch = await this.findAwaitingConfirmation(batchId, documentType);
    const analysis = batch.analysis as unknown as DocumentAnalysis | null;
    if (analysis?.verdict === 'REUPLOAD_REQUIRED') {
      throw new UnprocessableEntityException('This file failed review and cannot be merged. Correct it and upload it again.');
    }

    const { count } = await this.prisma.documentUploadBatch.updateMany({
      where: { id: batchId, status: DocumentBatchStatus.AWAITING_CONFIRMATION },
      data: { status: DocumentBatchStatus.PENDING, confirmedAt: new Date() },
    });
    if (count === 0) {
      throw new ConflictException('This upload is no longer awaiting confirmation');
    }
  }

  async cancel(batchId: string, documentType: DocumentType) {
    const batch = await this.findAwaitingConfirmation(batchId, documentType);

    const { count } = await this.prisma.documentUploadBatch.updateMany({
      where: { id: batchId, status: DocumentBatchStatus.AWAITING_CONFIRMATION },
      data: { status: DocumentBatchStatus.CANCELLED, completedAt: new Date() },
    });
    if (count === 0) {
      throw new ConflictException('This upload is no longer awaiting confirmation');
    }
    await this.fileStorageProvider.deleteObject(batch.storageKey);
  }

  private async findAwaitingConfirmation(batchId: string, documentType: DocumentType) {
    const batch = await this.prisma.documentUploadBatch.findUnique({ where: { id: batchId } });
    if (!batch || batch.documentType !== documentType) {
      throw new NotFoundException('Upload not found');
    }
    if (batch.status !== DocumentBatchStatus.AWAITING_CONFIRMATION) {
      throw new ConflictException('This upload is no longer awaiting confirmation');
    }
    return batch;
  }

  async markProcessing(batchId: string): Promise<void> {
    await this.prisma.documentUploadBatch.update({
      where: { id: batchId },
      data: { status: DocumentBatchStatus.PROCESSING, startedAt: new Date() },
    });
  }

  async markCompleted(batchId: string, result: BatchResult): Promise<void> {
    await this.prisma.documentUploadBatch.update({
      where: { id: batchId },
      data: {
        status: DocumentBatchStatus.COMPLETED,
        rowsProcessed: result.rowsProcessed,
        rowsCreated: result.rowsCreated,
        rowsUpdated: result.rowsUpdated,
        rowsSkipped: result.rowsSkipped,
        warnings: result.warnings,
        snapshotExportId: result.snapshotExportId,
        completedAt: new Date(),
      },
    });
  }

  async markFailed(batchId: string, errorMessage: string): Promise<void> {
    await this.prisma.documentUploadBatch.update({
      where: { id: batchId },
      data: { status: DocumentBatchStatus.FAILED, errorMessage, completedAt: new Date() },
    });
  }

  // Raw row, untouched — for internal pipeline use only (DocumentIngestionProcessor
  // needs the real storageKey/documentType to actually process the batch). Never
  // expose this one through an API response; use findById for that.
  async findRawById(batchId: string) {
    return this.prisma.documentUploadBatch.findUnique({ where: { id: batchId } });
  }

  async findById(batchId: string) {
    const batch = await this.prisma.documentUploadBatch.findUnique({
      where: { id: batchId },
      include: {
        snapshotExport: {
          select: { id: true, documentType: true, recordCount: true, sqlStorageKey: true, csvStorageKey: true, generatedAt: true },
        },
        uploadedBy: { select: { id: true, fullName: true, email: true } },
      },
    });
    if (!batch) {
      return batch;
    }

    const { storageKey, snapshotExport, ...rest } = batch;
    const [fileUrl, hydratedSnapshotExport] = await Promise.all([
      this.fileStorageProvider.getSignedDownloadUrl(storageKey),
      this.hydrateSnapshotExport(snapshotExport),
    ]);

    return { ...rest, fileUrl, snapshotExport: hydratedSnapshotExport };
  }

  private async hydrateSnapshotExport(
    snapshotExport: {
      id: string;
      documentType: DocumentType;
      recordCount: number;
      sqlStorageKey: string;
      csvStorageKey: string;
      generatedAt: Date;
    } | null,
  ) {
    if (!snapshotExport) {
      return null;
    }
    const { sqlStorageKey, csvStorageKey, ...rest } = snapshotExport;
    const [sqlUrl, csvUrl] = await Promise.all([
      this.fileStorageProvider.getSignedDownloadUrl(sqlStorageKey),
      this.fileStorageProvider.getSignedDownloadUrl(csvStorageKey),
    ]);
    return { ...rest, sqlUrl, csvUrl };
  }

  async list(
    filters: ListBatchesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.DocumentUploadBatchWhereInput = {
      documentType: filters.documentType,
      status: filters.status,
      period: filters.period,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      completedAt:
        filters.completedFrom || filters.completedTo
          ? { gte: filters.completedFrom, lte: filters.completedTo }
          : undefined,
      OR: filters.q
        ? [
            { originalFileName: { contains: filters.q, mode: 'insensitive' } },
            { storedFileName: { contains: filters.q, mode: 'insensitive' } },
            { period: { contains: filters.q, mode: 'insensitive' } },
            { uploadedBy: { fullName: { contains: filters.q, mode: 'insensitive' } } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.documentUploadBatch.findMany({
        where,
        include: {
          uploadedBy: { select: { id: true, fullName: true, email: true } },
          snapshotExport: { select: { id: true, documentType: true, generatedAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.documentUploadBatch.count({ where }),
    ]);

    const hydrated = await Promise.all(
      data.map(async (batch) => {
        const { storageKey, ...rest } = batch;
        return { ...rest, fileUrl: await this.fileStorageProvider.getSignedDownloadUrl(storageKey) };
      }),
    );

    return buildPaginatedResult(hydrated, total, page, limit);
  }
}
