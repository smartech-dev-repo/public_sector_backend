import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

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
}
