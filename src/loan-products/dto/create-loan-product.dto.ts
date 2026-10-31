import { ArrayMinSize, IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';
import { ManagementChargeApplication, ManagementChargeType } from '../../generated/prisma/client';
import { InterestTier } from '../interest-tier.interface';

export class CreateLoanProductDto {
  @IsString()
  @MinLength(1)
  productName: string;

  @IsString()
  @MinLength(1)
  productCode: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  sectors: string[];

  @IsNumber()
  @IsPositive()
  minimumAmount: number;

  @IsNumber()
  @IsPositive()
  maximumAmount: number;

  @IsInt()
  @IsPositive()
  minimumTenorMonths: number;

  @IsInt()
  @IsPositive()
  maximumTenorMonths: number;

  @IsArray()
  @ArrayMinSize(1)
  interestTiers: InterestTier[];

  // Required unless a management fee is picked from the catalog below.
  @ValidateIf((dto: CreateLoanProductDto) => !dto.managementFeeId)
  @IsEnum(ManagementChargeType)
  managementChargeType?: ManagementChargeType;

  @ValidateIf((dto: CreateLoanProductDto) => !dto.managementFeeId)
  @IsNumber()
  @IsPositive()
  managementChargeValue?: number;

  @IsOptional()
  @IsUUID()
  managementFeeId?: string;

  @IsEnum(ManagementChargeApplication)
  managementChargeApplication: ManagementChargeApplication;

  @IsOptional()
  @IsInt()
  @IsPositive()
  minimumServiceMonthsLeft?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maximumMonthsInService?: number;
}
