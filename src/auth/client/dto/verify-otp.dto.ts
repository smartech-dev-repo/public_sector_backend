import { IsPhoneNumber, IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsPhoneNumber()
  phone: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
