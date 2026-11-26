import { Transform } from 'class-transformer';
import { IsNumber, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

export class WalletTransactionDto {
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount must be a number with at most 2 decimal places' })
  @IsPositive()
  amount: number;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'description is required' })
  @MaxLength(500)
  description: string;
}
