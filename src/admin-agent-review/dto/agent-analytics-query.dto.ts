import { IsISO8601, IsOptional } from 'class-validator';

export class AgentAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
