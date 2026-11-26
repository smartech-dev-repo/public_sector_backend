import { IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListClientLoanProductsQueryDto extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;
}
