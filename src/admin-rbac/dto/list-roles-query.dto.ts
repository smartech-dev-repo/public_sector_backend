import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListRolesQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
