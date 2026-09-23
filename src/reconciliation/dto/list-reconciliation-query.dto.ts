import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { VarianceStatus } from '../../generated/prisma/client';

export class ListReconciliationQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  agency?: string;

  @IsOptional()
  @IsEnum(VarianceStatus)
  status?: VarianceStatus;

  @IsOptional()
  @IsString()
  period?: string;

  @IsOptional()
  @IsISO8601()
  generatedFrom?: string;

  @IsOptional()
  @IsISO8601()
  generatedTo?: string;
}
