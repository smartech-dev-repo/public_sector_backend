import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';
import { ManagementChargeApplication, ManagementChargeType } from '../../generated/prisma/client';
import { InterestTier } from '../interest-tier.interface';

export class UpdateLoanProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  productName?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  sectors?: string[];

  @IsOptional()
  @IsNumber()
  @IsPositive()
  minimumAmount?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maximumAmount?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  minimumTenorMonths?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maximumTenorMonths?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  interestTiers?: InterestTier[];

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
  @IsInt()
  @IsPositive()
  minimumServiceMonthsLeft?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maximumMonthsInService?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
