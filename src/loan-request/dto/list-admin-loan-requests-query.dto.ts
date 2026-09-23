import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { LoanRequestStatus, LoanRequestType } from '../../generated/prisma/client';

export class ListAdminLoanRequestsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(LoanRequestStatus)
  status?: LoanRequestStatus;

  @IsOptional()
  @IsEnum(LoanRequestType)
  type?: LoanRequestType;

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @IsOptional()
  @IsISO8601()
  disbursedFrom?: string;

  @IsOptional()
  @IsISO8601()
  disbursedTo?: string;
}
