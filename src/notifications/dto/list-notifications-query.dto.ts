import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListNotificationsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  unread?: boolean;
}
