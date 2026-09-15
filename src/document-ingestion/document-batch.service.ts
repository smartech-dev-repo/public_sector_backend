import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentBatchStatus, DocumentType } from '../generated/prisma/client';

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
      include: { snapshotExport: true },
    });
  }

  async list(filters: ListBatchesFilters) {
    return this.prisma.documentUploadBatch.findMany({
      where: { documentType: filters.documentType, status: filters.status },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
