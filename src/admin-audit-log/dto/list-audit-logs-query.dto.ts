import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AuditActorType } from '../../generated/prisma/client';

export class ListAuditLogsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(AuditActorType)
  actorType?: AuditActorType;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  actor?: string;

  @IsOptional()
  @IsIn(['success', 'failed', 'blocked'])
  outcome?: 'success' | 'failed' | 'blocked';

  @IsOptional()
  @IsIn(['event', 'request'])
  kind?: 'event' | 'request';

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  targetType?: string;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
