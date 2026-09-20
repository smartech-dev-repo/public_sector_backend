import { IsString } from 'class-validator';

export class DisableTwoFactorDto {
  @IsString()
  currentPassword: string;
}
