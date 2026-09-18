import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentBatchService } from './document-batch.service';
import { SnapshotExportService } from './snapshot-export.service';
import { DocumentIngestionProcessor } from './document-ingestion.processor';
import { NoOpDocumentParser } from './no-op-document.parser';
import { IppisBroadsheetParser } from './parsers/ippis-broadsheet.parser';
import { DisbursedLoansParser } from './parsers/disbursed-loans.parser';
import { RepaymentScheduleParser } from './parsers/repayment-schedule.parser';
import { DOCUMENT_PARSERS } from './document-parser.interface';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AuditModule } from '../audit/audit.module';
import { DocumentType } from '../generated/prisma/client';
import { AdminDocumentsController } from './admin-documents.controller';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: DOCUMENT_INGESTION_QUEUE }),
    FileStorageModule,
    AuditModule,
    ReconciliationModule,
  ],
  controllers: [AdminDocumentsController],
  providers: [
    DocumentBatchService,
    SnapshotExportService,
    DocumentIngestionProcessor,
    NoOpDocumentParser,
    IppisBroadsheetParser,
    DisbursedLoansParser,
    RepaymentScheduleParser,
    {
      provide: DOCUMENT_PARSERS,
      useFactory: (
        noOpParser: NoOpDocumentParser,
        ippisParser: IppisBroadsheetParser,
        loansParser: DisbursedLoansParser,
        repaymentParser: RepaymentScheduleParser,
      ) => ({
        [DocumentType.IPPIS_BROADSHEET]: ippisParser,
        [DocumentType.REPAYMENT_SCHEDULE]: repaymentParser,
        [DocumentType.DISBURSED_LOANS]: loansParser,
      }),
      inject: [NoOpDocumentParser, IppisBroadsheetParser, DisbursedLoansParser, RepaymentScheduleParser],
    },
  ],
  exports: [DocumentBatchService, SnapshotExportService, BullModule],
})
export class DocumentIngestionModule {}
