import { IsNumber, IsPositive } from 'class-validator';

export class CreateLoanRequestDto {
  @IsNumber()
  @IsPositive()
  amount: number;
}
