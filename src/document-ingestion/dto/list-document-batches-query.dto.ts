import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { DocumentBatchStatus, DocumentType } from '../../generated/prisma/client';

export class ListDocumentBatchesQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  @IsOptional()
  @IsEnum(DocumentBatchStatus)
  status?: DocumentBatchStatus;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @IsOptional()
  @IsISO8601()
  completedFrom?: string;

  @IsOptional()
  @IsISO8601()
  completedTo?: string;
}
