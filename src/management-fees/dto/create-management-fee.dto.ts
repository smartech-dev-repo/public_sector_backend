import { IsEnum, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { ManagementChargeType } from '../../generated/prisma/client';

export class CreateManagementFeeDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsEnum(ManagementChargeType)
  type: ManagementChargeType;

  @IsNumber()
  @Min(0)
  value: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minAmount?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAmount?: number | null;
}
