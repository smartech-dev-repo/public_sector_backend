import { IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { ClientLoanStatus } from '../../generated/prisma/client';

export class ListClientLoansQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  clientId?: string;

  /** Client name, phone, email, IPPIS number or ID. */
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(ClientLoanStatus)
  status?: ClientLoanStatus;

  @IsOptional()
  @IsString()
  agency?: string;

  @IsOptional()
  @IsISO8601()
  disbursedFrom?: string;

  @IsOptional()
  @IsISO8601()
  disbursedTo?: string;
}
