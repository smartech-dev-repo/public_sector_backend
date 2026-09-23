import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { LoanRequestStatus } from '../../generated/prisma/client';

export class ListClientLoanRequestsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(LoanRequestStatus)
  status?: LoanRequestStatus;
}
