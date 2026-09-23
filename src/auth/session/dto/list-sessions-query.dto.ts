import { IsISO8601, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/pagination/pagination.dto';

export class ListSessionsQueryDto extends PaginationDto {
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
