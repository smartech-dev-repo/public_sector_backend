import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from 'class-validator';

export class LoanEligibilityQueryDto {
  /** The tenor the client picked, in months. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(360)
  tenorMonths: number;

  /** LOAN or TOPUP. Left out, it is a top-up when the client already has a loan. */
  @IsOptional()
  @IsIn(['LOAN', 'TOPUP'])
  type?: 'LOAN' | 'TOPUP';

  /**
   * Optional: an amount to check. The answer then also says whether this amount would be
   * accepted, and its monthly repayment, charge and payout. For a top-up, the extra cash.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;
}
