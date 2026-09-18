import { IsEmail, IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class RegisterAgentDto {
  @IsString()
  @MinLength(1)
  fullName: string;

  @IsEmail()
  email: string;

  @IsPhoneNumber()
  phone: string;

  @IsString()
  @MinLength(1)
  address: string;
}
