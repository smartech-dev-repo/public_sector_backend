import { IsEnum, IsInt, IsNumber, IsPositive, IsString, MinLength } from 'class-validator';
import { ManagementChargeApplication, ManagementChargeType } from '../../generated/prisma/client';

export class CreateLoanTermOptionDto {
  @IsString()
  @MinLength(1)
  agency: string;

  @IsInt()
  @IsPositive()
  tenorMonths: number;

  @IsNumber()
  @IsPositive()
  interestRatePercent: number;

  @IsEnum(ManagementChargeType)
  managementChargeType: ManagementChargeType;

  @IsNumber()
  @IsPositive()
  managementChargeValue: number;

  @IsEnum(ManagementChargeApplication)
  managementChargeApplication: ManagementChargeApplication;
}
