import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ReportDataAccessDto {
  @IsIn(['reveal', 'export'])
  kind: 'reveal' | 'export';

  @IsString()
  @MaxLength(80)
  resource: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  recordCount?: number;
}
