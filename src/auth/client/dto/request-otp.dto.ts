import { IsEmail, IsOptional } from 'class-validator';
import { IsNigerianPhone } from '../../../common/is-nigerian-phone.decorator';

export class RequestOtpDto {
  @IsNigerianPhone()
  phone: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
