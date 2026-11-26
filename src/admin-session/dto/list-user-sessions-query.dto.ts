import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { SessionPrincipalType } from '../../generated/prisma/client';

export class ListUserSessionsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(SessionPrincipalType)
  userType?: SessionPrincipalType;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsIn(['active', 'revoked', 'expired'])
  status?: 'active' | 'revoked' | 'expired';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
