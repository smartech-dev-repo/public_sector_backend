import { IsEmail, IsOptional, IsPhoneNumber } from 'class-validator';

export class RequestOtpDto {
  @IsPhoneNumber()
  phone: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
