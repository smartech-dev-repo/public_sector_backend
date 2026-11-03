import { IsInt, IsObject, IsOptional, IsPositive } from 'class-validator';
import { RepaymentCapacityDto } from './repayment-capacity.dto';
import { IsNigerianPhone } from '../../common/is-nigerian-phone.decorator';

/** The default repayment capacity comes from RepaymentCapacityDto. */
export class UpdateLoanSettingsDto extends RepaymentCapacityDto {
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

  /** Outcome per salary pattern, e.g. { "ABC": "B" }. Patterns left out keep their value. */
  @IsOptional()
  @IsObject()
  salaryPatternOutcomes?: Record<string, string>;
}
