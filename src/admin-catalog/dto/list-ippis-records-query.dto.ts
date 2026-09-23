import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListIppisRecordsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  agency?: string;

  @IsOptional()
  @IsString()
  employeeStatus?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  grade?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  hireDateFrom?: string;

  @IsOptional()
  @IsISO8601()
  hireDateTo?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
