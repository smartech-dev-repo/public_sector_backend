import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAlertRecipientDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
