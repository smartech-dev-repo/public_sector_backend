import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentBatchStatus, DocumentType, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

export interface CreateBatchParams {
  documentType: DocumentType;
  uploadedById: string;
  originalFileName: string;
  storageKey: string;
  period?: string;
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
  createdFrom?: Date;
  createdTo?: Date;
  completedFrom?: Date;
  completedTo?: Date;
}

@Injectable()
export class DocumentBatchService {
  constructor(private readonly prisma: PrismaService) {}

  async createBatch(params: CreateBatchParams) {
    return this.prisma.documentUploadBatch.create({
      data: {
        documentType: params.documentType,
        uploadedById: params.uploadedById,
        originalFileName: params.originalFileName,
        storageKey: params.storageKey,
        period: params.period,
      },
    });
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

  async findById(batchId: string) {
    return this.prisma.documentUploadBatch.findUnique({
      where: { id: batchId },
      include: {
        snapshotExport: true,
        uploadedBy: { select: { id: true, fullName: true, email: true } },
      },
    });
  }

  async list(
    filters: ListBatchesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.DocumentUploadBatchWhereInput = {
      documentType: filters.documentType,
      status: filters.status,
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
            { period: { contains: filters.q, mode: 'insensitive' } },
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

    return buildPaginatedResult(data, total, page, limit);
  }
}
