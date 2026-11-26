import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

const LOAN_STATUSES = ['ACTIVE', 'DEFAULT', 'CLOSED'] as const;

export class ListLoansQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(LOAN_STATUSES)
  status?: (typeof LOAN_STATUSES)[number];

  @IsOptional()
  @IsString()
  product?: string;

  @IsOptional()
  @IsISO8601()
  disbursedFrom?: string;

  @IsOptional()
  @IsISO8601()
  disbursedTo?: string;
}
