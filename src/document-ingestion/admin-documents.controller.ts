import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
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
import { ANALYZE_BATCH_JOB, DocumentIngestionJobData } from './document-ingestion.processor';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentBatchStatus, DocumentType } from '../generated/prisma/client';
import { ListDocumentBatchesQueryDto } from './dto/list-document-batches-query.dto';
import { ValidateDocumentUploadDto } from './dto/validate-document-upload.dto';
import { SPREADSHEET_UPLOAD_OPTIONS } from './spreadsheet-upload.options';
import { buildStoredFileName } from './stored-file-name.util';
import { isCsvFile } from './parsers/load-uploaded-workbook';
import {
  buildTemplateWorkbook,
  DOCUMENT_SLUGS,
  DOCUMENT_TEMPLATES,
  DOCUMENT_UPLOAD_PERMISSIONS,
} from './document-templates';

@Controller('admin/documents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminDocumentsController {
  constructor(
    private readonly documentBatchService: DocumentBatchService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    @InjectQueue(DOCUMENT_INGESTION_QUEUE) private readonly queue: Queue<DocumentIngestionJobData>,
  ) {}

  private async storeUpload(
    documentType: DocumentType,
    file: Express.Multer.File,
    uploaderId: string,
    period: string | undefined,
    status: DocumentBatchStatus,
    sheetName?: string,
  ) {
    const storedFileName = buildStoredFileName(file.originalname);
    const storageKey = `uploads/${documentType.toLowerCase()}/${storedFileName}`;
    await this.fileStorageProvider.putObject(storageKey, file.buffer);

    return this.documentBatchService.createBatch({
      documentType,
      uploadedById: uploaderId,
      originalFileName: file.originalname,
      sheetName,
      storedFileName,
      fileSizeBytes: file.size,
      storageKey,
      period,
      status,
    });
  }

  private async createAndEnqueue(
    documentType: DocumentType,
    file: Express.Multer.File,
    uploaderId: string,
    period?: string,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (isCsvFile(file.originalname) && DOCUMENT_TEMPLATES[documentType].csvAgencies.length > 0) {
      throw new BadRequestException('A CSV of this type needs an agency: upload it through /validate');
    }
    const batch = await this.storeUpload(documentType, file, uploaderId, period, DocumentBatchStatus.PENDING);
    await this.queue.add('process-batch', { batchId: batch.id });

    return { id: batch.id, status: batch.status, documentType: batch.documentType };
  }

  // These routes are shared by three document types, each with its own upload
  // permission, so the check can't be a static @RequirePermissions.
  private resolveDocumentType(slug: string, user: JwtPayload): DocumentType {
    const documentType = DOCUMENT_SLUGS[slug];
    if (!documentType) {
      throw new NotFoundException('Unknown document type');
    }
    if (!user.permissions?.includes(DOCUMENT_UPLOAD_PERMISSIONS[documentType])) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return documentType;
  }

  @Get('templates/:documentType')
  getTemplateSpec(@Param('documentType') slug: string, @Req() req: { user: JwtPayload }) {
    return DOCUMENT_TEMPLATES[this.resolveDocumentType(slug, req.user)];
  }

  @Get('templates/:documentType/download')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async downloadTemplate(@Param('documentType') slug: string, @Req() req: { user: JwtPayload }) {
    const documentType = this.resolveDocumentType(slug, req.user);
    return new StreamableFile(await buildTemplateWorkbook(documentType), {
      disposition: `attachment; filename="${DOCUMENT_TEMPLATES[documentType].fileName}"`,
    });
  }

  @Post(':documentType/validate')
  @UseInterceptors(FileInterceptor('file', SPREADSHEET_UPLOAD_OPTIONS))
  async validateUpload(
    @Param('documentType') slug: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: ValidateDocumentUploadDto,
    @Req() req: { user: JwtPayload },
  ) {
    const documentType = this.resolveDocumentType(slug, req.user);
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (documentType === DocumentType.REPAYMENT_SCHEDULE && !dto.period) {
      throw new BadRequestException('period is required for a repayment schedule');
    }

    const { csvAgencies } = DOCUMENT_TEMPLATES[documentType];
    const needsAgency = isCsvFile(file.originalname) && csvAgencies.length > 0;
    if (needsAgency && !csvAgencies.includes(dto.agency ?? '')) {
      throw new BadRequestException(`A CSV needs an agency: one of ${csvAgencies.join(', ')}`);
    }

    const batch = await this.storeUpload(
      documentType,
      file,
      req.user.sub,
      dto.period,
      DocumentBatchStatus.ANALYZING,
      needsAgency ? dto.agency : undefined,
    );
    await this.queue.add(ANALYZE_BATCH_JOB, { batchId: batch.id });

    return {
      id: batch.id,
      status: batch.status,
      documentType: batch.documentType,
      originalFileName: batch.originalFileName,
      storedFileName: batch.storedFileName,
      fileSizeBytes: batch.fileSizeBytes,
    };
  }

  @Post(':documentType/batches/:id/confirm')
  @HttpCode(200)
  async confirmUpload(
    @Param('documentType') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayload },
  ) {
    await this.documentBatchService.confirm(id, this.resolveDocumentType(slug, req.user));
    await this.queue.add('process-batch', { batchId: id });
    return { id, status: DocumentBatchStatus.PENDING };
  }

  @Post(':documentType/batches/:id/cancel')
  @HttpCode(200)
  async cancelUpload(
    @Param('documentType') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: JwtPayload },
  ) {
    await this.documentBatchService.cancel(id, this.resolveDocumentType(slug, req.user));
    return { id, status: DocumentBatchStatus.CANCELLED };
  }

  @Post('ippis-broadsheet/upload')
  @UseInterceptors(FileInterceptor('file', SPREADSHEET_UPLOAD_OPTIONS))
  @RequirePermissions('ippis:upload')
  uploadIppisBroadsheet(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { user: JwtPayload },
  ) {
    return this.createAndEnqueue(DocumentType.IPPIS_BROADSHEET, file, req.user.sub);
  }

  @Post('disbursed-loans/upload')
  @UseInterceptors(FileInterceptor('file', SPREADSHEET_UPLOAD_OPTIONS))
  @RequirePermissions('loans:upload')
  uploadDisbursedLoans(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { user: JwtPayload },
  ) {
    return this.createAndEnqueue(DocumentType.DISBURSED_LOANS, file, req.user.sub);
  }

  @Post('repayment-schedule/upload')
  @UseInterceptors(FileInterceptor('file', SPREADSHEET_UPLOAD_OPTIONS))
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
        period: query.period,
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
