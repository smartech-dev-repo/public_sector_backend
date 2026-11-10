import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { RepaymentMatchStatus, RepaymentResolution } from '../../generated/prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const DEDUCTION_VIEWS = ['UNRESOLVED', 'RESOLVED', 'ALL'] as const;
export type DeductionView = (typeof DEDUCTION_VIEWS)[number];

export class ListDeductionsQueryDto extends PaginationDto {
  /** UNRESOLVED (default): matched no loan and not yet dealt with. RESOLVED: assigned, refunded or dismissed. */
  @IsOptional()
  @IsIn(DEDUCTION_VIEWS)
  view?: DeductionView;

  @IsOptional()
  @IsEnum(RepaymentMatchStatus)
  matchStatus?: RepaymentMatchStatus;

  @IsOptional()
  @IsEnum(RepaymentResolution)
  resolution?: RepaymentResolution;

  @IsOptional()
  @IsString()
  agency?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be in YYYY-MM format' })
  period?: string;

  /** Staff ID, matched in part and ignoring case. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  search?: string;
}

export class AssignDeductionDto {
  /** The app loan to count the deduction toward. Give this or loanId. */
  @IsOptional()
  @IsUUID()
  clientLoanId?: string;

  /** The imported (disbursed-loans) loan to count it toward. Give this or clientLoanId. */
  @IsOptional()
  @IsUUID()
  loanId?: string;

  /** The month it counts toward. Defaults to the month it was uploaded for. */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be in YYYY-MM format' })
  period?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RefundDeductionDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class DismissDeductionDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'note is required to dismiss a deduction' })
  @MaxLength(500)
  note: string;
}
