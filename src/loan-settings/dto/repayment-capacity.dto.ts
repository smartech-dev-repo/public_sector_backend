import {
  IsIn,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * How much of a client's salary can go to repayment. BASE_PAY keeps basePayAmount for the
 * client each month; DTI allows dtiPercent of salary. Send affordabilityMethod: null to clear
 * the setting, so the level below applies (client → sector → default).
 */
export class RepaymentCapacityDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(['BASE_PAY', 'DTI'])
  affordabilityMethod?: 'BASE_PAY' | 'DTI' | null;

  /** Naira the client keeps each month. Required with BASE_PAY. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  basePayAmount?: number | null;

  /** Share of salary for repayment, e.g. 33.33. Required with DTI. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  dtiPercent?: number | null;
}
