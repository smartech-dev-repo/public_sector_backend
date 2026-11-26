import { IsString, Length } from 'class-validator';

export class ConfirmLoanRequestCodeDto {
  @IsString()
  @Length(6, 8)
  code: string;
}
