import { IsEnum, IsISO8601, IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AuditActorType, WalletEntryDirection } from '../../generated/prisma/client';

export class ListWalletEntriesQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(WalletEntryDirection)
  direction?: WalletEntryDirection;

  @IsOptional()
  @IsEnum(AuditActorType)
  actorType?: AuditActorType;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
