import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListWalletsQueryDto extends PaginationDto {
  /** Client name, phone or staff ID. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['POSITIVE', 'ZERO'])
  balance?: 'POSITIVE' | 'ZERO';

  @IsOptional()
  @IsIn(['balance', 'recent', 'credited', 'debited'])
  sort?: 'balance' | 'recent' | 'credited' | 'debited';

  /** The period the summary's credited/debited figures cover; this month by default. */
  @IsOptional()
  @IsISO8601()
  periodFrom?: string;

  @IsOptional()
  @IsISO8601()
  periodTo?: string;
}
