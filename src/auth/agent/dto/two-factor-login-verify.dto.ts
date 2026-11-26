import { IsString } from 'class-validator';

export class TwoFactorLoginVerifyDto {
  @IsString()
  pendingToken: string;

  @IsString()
  code: string;
}
