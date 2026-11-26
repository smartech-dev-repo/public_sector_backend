import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListActivitiesQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsISO8601()
  occurredFrom?: string;

  @IsOptional()
  @IsISO8601()
  occurredTo?: string;
}
