import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AgentApplicationStatus } from '../../generated/prisma/client';

export class ListRecruitmentApplicationsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(AgentApplicationStatus)
  status?: AgentApplicationStatus;

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
