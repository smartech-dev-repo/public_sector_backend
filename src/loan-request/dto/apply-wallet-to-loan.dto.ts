import { IsNumber, IsPositive } from 'class-validator';

export class ApplyWalletToLoanDto {
  @IsNumber()
  @IsPositive()
  amount: number;
}
