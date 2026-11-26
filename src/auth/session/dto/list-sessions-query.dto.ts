import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../common/pagination/pagination.dto';

export class ListSessionsQueryDto extends PaginationDto {
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
