import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentBatchService } from './document-batch.service';
import { SnapshotExportService } from './snapshot-export.service';
import { DocumentIngestionProcessor } from './document-ingestion.processor';
import { NoOpDocumentParser } from './no-op-document.parser';
import { DOCUMENT_PARSERS } from './document-parser.interface';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AuditModule } from '../audit/audit.module';
import { DocumentType } from '../generated/prisma/client';
import { AdminDocumentsController } from './admin-documents.controller';

@Module({
  imports: [
    BullModule.registerQueue({ name: DOCUMENT_INGESTION_QUEUE }),
    FileStorageModule,
    AuditModule,
  ],
  controllers: [AdminDocumentsController],
  providers: [
    DocumentBatchService,
    SnapshotExportService,
    DocumentIngestionProcessor,
    NoOpDocumentParser,
    {
      provide: DOCUMENT_PARSERS,
      useFactory: (noOpParser: NoOpDocumentParser) => ({
        [DocumentType.IPPIS_BROADSHEET]: noOpParser,
        [DocumentType.REPAYMENT_SCHEDULE]: noOpParser,
        [DocumentType.DISBURSED_LOANS]: noOpParser,
      }),
      inject: [NoOpDocumentParser],
    },
  ],
  exports: [DocumentBatchService, SnapshotExportService, BullModule],
})
export class DocumentIngestionModule {}
