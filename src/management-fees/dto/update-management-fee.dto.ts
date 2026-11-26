import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { ManagementChargeType } from '../../generated/prisma/client';

export class UpdateManagementFeeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsEnum(ManagementChargeType)
  type?: ManagementChargeType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  // null clears a bound, which is how a ranged fee becomes a general one.
  @IsOptional()
  @IsNumber()
  @Min(0)
  minAmount?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAmount?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
