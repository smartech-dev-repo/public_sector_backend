import { IsEnum } from 'class-validator';
import { TwoFactorMethod } from '../../../generated/prisma/client';

export class SetupTwoFactorDto {
  @IsEnum(TwoFactorMethod)
  method: TwoFactorMethod;
}
