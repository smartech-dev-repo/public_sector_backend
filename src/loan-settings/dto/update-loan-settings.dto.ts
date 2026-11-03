import { IsInt, IsOptional, IsPositive } from 'class-validator';
import { IsNigerianPhone } from '../../common/is-nigerian-phone.decorator';

export class UpdateLoanSettingsDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  retirementAgeYears?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maxServiceYears?: number;

  /** Admin number clients send their code to when an agent requested the loan. Stored as +234…. */
  @IsOptional()
  @IsNigerianPhone()
  loanApprovalPhone?: string;
}
