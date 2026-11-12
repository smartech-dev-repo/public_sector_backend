import { IsEnum, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AuditActorType, WalletEntryDirection, WalletEntrySource } from '../../generated/prisma/client';

export class ListWalletEntriesQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(WalletEntryDirection)
  direction?: WalletEntryDirection;

  @IsOptional()
  @IsEnum(AuditActorType)
  actorType?: AuditActorType;

  @IsOptional()
  @IsEnum(WalletEntrySource)
  source?: WalletEntrySource;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}

/** Movements across every wallet; search matches the client's name, phone or staff ID. */
export class ListAllWalletEntriesQueryDto extends ListWalletEntriesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
