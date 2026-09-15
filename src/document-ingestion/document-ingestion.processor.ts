import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentBatchService } from './document-batch.service';
import { DOCUMENT_PARSERS, DocumentParser } from './document-parser.interface';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentType } from '../generated/prisma/client';

export interface DocumentIngestionJobData {
  batchId: string;
}

@Processor(DOCUMENT_INGESTION_QUEUE)
export class DocumentIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentIngestionProcessor.name);

  constructor(
    private readonly documentBatchService: DocumentBatchService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    @Inject(DOCUMENT_PARSERS) private readonly parsers: Record<DocumentType, DocumentParser>,
  ) {
    super();
  }

  async process(job: Job<DocumentIngestionJobData>): Promise<void> {
    const { batchId } = job.data;
    const batch = await this.documentBatchService.findById(batchId);

    if (!batch) {
      this.logger.error(`Batch ${batchId} not found`);
      return;
    }

    await this.documentBatchService.markProcessing(batchId);

    try {
      const fileBuffer = await this.fileStorageProvider.getObject(batch.storageKey);
      const parser = this.parsers[batch.documentType];
      const result = await parser.parse(batch, fileBuffer);

      await this.documentBatchService.markCompleted(batchId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch ${batchId} failed: ${message}`);
      await this.documentBatchService.markFailed(batchId, message);
    }
  }
}
