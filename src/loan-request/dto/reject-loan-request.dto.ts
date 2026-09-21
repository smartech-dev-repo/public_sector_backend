import { IsString, MinLength } from 'class-validator';

export class RejectLoanRequestDto {
  @IsString()
  @MinLength(1)
  reason: string;
}
