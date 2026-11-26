import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AdminInviteStatus } from '../../generated/prisma/client';

export class ListInvitesQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(AdminInviteStatus)
  status?: AdminInviteStatus;

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
  expiresFrom?: string;

  @IsOptional()
  @IsISO8601()
  expiresTo?: string;
}
