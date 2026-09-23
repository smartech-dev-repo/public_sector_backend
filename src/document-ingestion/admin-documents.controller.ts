import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { DocumentBatchService } from './document-batch.service';
import { UploadRepaymentScheduleDto } from './dto/upload-repayment-schedule.dto';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentIngestionJobData } from './document-ingestion.processor';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentBatchStatus, DocumentType } from '../generated/prisma/client';
import { ListDocumentBatchesQueryDto } from './dto/list-document-batches-query.dto';

@Controller('admin/documents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminDocumentsController {
  constructor(
    private readonly documentBatchService: DocumentBatchService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    @InjectQueue(DOCUMENT_INGESTION_QUEUE) private readonly queue: Queue<DocumentIngestionJobData>,
  ) {}

  private async createAndEnqueue(
    documentType: DocumentType,
    file: Express.Multer.File,
    uploaderId: string,
    period?: string,
  ) {
    const storageKey = `uploads/${documentType.toLowerCase()}/${Date.now()}-${file.originalname}`;
    await this.fileStorageProvider.putObject(storageKey, file.buffer);

    const batch = await this.documentBatchService.createBatch({
      documentType,
      uploadedById: uploaderId,
      originalFileName: file.originalname,
      storageKey,
      period,
    });

    await this.queue.add('process-batch', { batchId: batch.id });

    return { id: batch.id, status: batch.status, documentType: batch.documentType };
  }

  @Post('ippis-broadsheet/upload')
  @UseInterceptors(FileInterceptor('file'))
  @RequirePermissions('ippis:upload')
  uploadIppisBroadsheet(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { user: JwtPayload },
  ) {
    return this.createAndEnqueue(DocumentType.IPPIS_BROADSHEET, file, req.user.sub);
  }

  @Post('disbursed-loans/upload')
  @UseInterceptors(FileInterceptor('file'))
  @RequirePermissions('loans:upload')
  uploadDisbursedLoans(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { user: JwtPayload },
  ) {
    return this.createAndEnqueue(DocumentType.DISBURSED_LOANS, file, req.user.sub);
  }

  @Post('repayment-schedule/upload')
  @UseInterceptors(FileInterceptor('file'))
  @RequirePermissions('repayments:upload')
  uploadRepaymentSchedule(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadRepaymentScheduleDto,
    @Req() req: { user: JwtPayload },
  ) {
    return this.createAndEnqueue(DocumentType.REPAYMENT_SCHEDULE, file, req.user.sub, dto.period);
  }

  @Get('batches')
  @RequirePermissions('documents:read')
  listBatches(@Query() query: ListDocumentBatchesQueryDto) {
    return this.documentBatchService.list(
      {
        documentType: query.documentType,
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        completedFrom: query.completedFrom ? new Date(query.completedFrom) : undefined,
        completedTo: query.completedTo ? new Date(query.completedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Get('batches/:id')
  @RequirePermissions('documents:read')
  getBatch(@Param('id') id: string) {
    return this.documentBatchService.findById(id);
  }
}
