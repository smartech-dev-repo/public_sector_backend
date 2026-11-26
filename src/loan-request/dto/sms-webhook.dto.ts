import { IsString, MinLength } from 'class-validator';

export class SmsWebhookDto {
  @IsString()
  @MinLength(1)
  phone: string;

  @IsString()
  message: string;
}
