import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentBatchService } from './document-batch.service';
import { DOCUMENT_PARSERS, DocumentParser } from './document-parser.interface';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { ClientLoanReconciliationService } from '../reconciliation/client-loan-reconciliation.service';
import { RepaymentMatchingService } from '../reconciliation/repayment-matching.service';
import { DocumentAnalysisService } from './analysis/document-analysis.service';
import { AuditActorType, DocumentType, DocumentUploadBatch, Prisma } from '../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';

export const ANALYZE_BATCH_JOB = 'analyze-batch';

export interface DocumentIngestionJobData {
  batchId: string;
}

const RECONCILIATION_TRIGGER_TYPES: DocumentType[] = [DocumentType.DISBURSED_LOANS, DocumentType.REPAYMENT_SCHEDULE];

// Reviewing a large workbook is slow, and a job that loses its lock is run twice.
@Processor(DOCUMENT_INGESTION_QUEUE, { lockDuration: 5 * 60 * 1000 })
export class DocumentIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentIngestionProcessor.name);

  constructor(
    private readonly documentBatchService: DocumentBatchService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    @Inject(DOCUMENT_PARSERS) private readonly parsers: Record<DocumentType, DocumentParser>,
    private readonly reconciliationService: ReconciliationService,
    private readonly clientLoanReconciliationService: ClientLoanReconciliationService,
    private readonly repaymentMatchingService: RepaymentMatchingService,
    private readonly documentAnalysisService: DocumentAnalysisService,
    private readonly auditLogService: AuditLogService,
  ) {
    super();
  }

  async process(job: Job<DocumentIngestionJobData>): Promise<void> {
    const { batchId } = job.data;
    const batch = await this.documentBatchService.findRawById(batchId);

    if (!batch) {
      this.logger.error(`Batch ${batchId} not found`);
      return;
    }

    if (job.name === ANALYZE_BATCH_JOB) {
      await this.analyze(batch);
      return;
    }

    await this.documentBatchService.markProcessing(batchId);

    try {
      const fileBuffer = await this.fileStorageProvider.getObject(batch.storageKey);
      const parser = this.parsers[batch.documentType];
      const result = await parser.parse(batch, fileBuffer);

      if (RECONCILIATION_TRIGGER_TYPES.includes(batch.documentType)) {
        // New deductions, or new loans, change which loan each deduction belongs to.
        await this.repaymentMatchingService.rematchAll();
        await this.reconciliationService.reconcileAll();
        await this.clientLoanReconciliationService.reconcileAll();
      }

      await this.documentBatchService.markCompleted(batchId, result);
      await this.recordOutcome(batch, 'document.upload.completed', {
        rowsProcessed: result.rowsProcessed,
        rowsCreated: result.rowsCreated,
        rowsUpdated: result.rowsUpdated,
        rowsSkipped: result.rowsSkipped,
        warningCount: result.warnings.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch ${batchId} failed: ${message}`, error instanceof Error ? error.stack : undefined);
      await this.documentBatchService.markFailed(batchId, message);
      await this.recordOutcome(batch, 'document.upload.failed', { stage: 'merge', error: message });
    }
  }

  private recordOutcome(batch: DocumentUploadBatch, action: string, details: Prisma.InputJsonObject) {
    return this.auditLogService.recordSafely({
      actorType: AuditActorType.SYSTEM,
      action,
      targetType: 'DocumentUploadBatch',
      targetId: batch.id,
      metadata: { documentType: batch.documentType, fileName: batch.originalFileName, period: batch.period, ...details },
    });
  }

  // Errors inside process() are caught there. This is for what never reaches that
  // catch, such as the worker dying mid-job, which would leave the upload stuck forever.
  @OnWorkerEvent('failed')
  async onJobFailed(job: Job<DocumentIngestionJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;
    this.logger.error(`Batch ${job.data.batchId} job failed: ${error.message}`);
    await this.documentBatchService.markFailed(job.data.batchId, 'Processing stopped unexpectedly. Please upload the file again.');
  }

  private async analyze(batch: DocumentUploadBatch): Promise<void> {
    try {
      const fileBuffer = await this.fileStorageProvider.getObject(batch.storageKey);
      const analysis = await this.documentAnalysisService.analyze(batch, fileBuffer);
      await this.documentBatchService.markAnalyzed(batch.id, analysis);
      await this.recordOutcome(batch, 'document.upload.reviewed', {
        verdict: analysis.verdict,
        totalRows: analysis.totalRows,
        rowsToCreate: analysis.rowsToCreate,
        rowsToUpdate: analysis.rowsToUpdate,
        rowsToSkip: analysis.rowsToSkip,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch ${batch.id} analysis failed: ${message}`, error instanceof Error ? error.stack : undefined);
      await this.documentBatchService.markFailed(batch.id, message);
      await this.recordOutcome(batch, 'document.upload.failed', { stage: 'review', error: message });
    }
  }
}
