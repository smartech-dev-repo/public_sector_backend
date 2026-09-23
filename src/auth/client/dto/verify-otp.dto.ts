import { IsPhoneNumber, IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsPhoneNumber()
  phone: string;

  // Must track PHONE_OTP_LENGTH's default (4) — class-validator DTOs
  // validate before any service code runs, so this can't read the env
  // var at request time. Keep this literal in sync if the default changes.
  @IsString()
  @Length(4, 4)
  code: string;
}
