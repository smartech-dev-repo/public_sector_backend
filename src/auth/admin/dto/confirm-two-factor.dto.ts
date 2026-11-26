import { IsString } from 'class-validator';

export class ConfirmTwoFactorDto {
  @IsString()
  code: string;
}
