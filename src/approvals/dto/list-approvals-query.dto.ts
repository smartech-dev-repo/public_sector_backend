import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { ApprovalStatus } from '../../generated/prisma/client';

export class ListApprovalsQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['to_decide', 'mine'])
  view?: 'to_decide' | 'mine';

  @IsOptional()
  @IsEnum(ApprovalStatus)
  status?: ApprovalStatus;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  action?: string;
}
