import { IsEmail, IsString, Length, MinLength } from 'class-validator';

export class ResetPasswordByCodeDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 8)
  code: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
