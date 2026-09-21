import { IsBoolean, IsEnum, IsNumber, IsOptional, IsPositive } from 'class-validator';
import { ManagementChargeApplication, ManagementChargeType } from '../../generated/prisma/client';

export class UpdateLoanTermOptionDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  interestRatePercent?: number;

  @IsOptional()
  @IsEnum(ManagementChargeType)
  managementChargeType?: ManagementChargeType;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  managementChargeValue?: number;

  @IsOptional()
  @IsEnum(ManagementChargeApplication)
  managementChargeApplication?: ManagementChargeApplication;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
