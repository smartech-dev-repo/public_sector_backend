import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListRolesQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  q?: string;
}
