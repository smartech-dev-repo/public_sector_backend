import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListDepartmentsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  q?: string;
}
