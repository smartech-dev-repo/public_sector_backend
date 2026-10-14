import { IsInt, IsOptional, IsPositive } from 'class-validator';

export class UpdateLoanSettingsDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  retirementAgeYears?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maxServiceYears?: number;
}
