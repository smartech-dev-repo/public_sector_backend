import { ConfigService } from '@nestjs/config';

export interface EmailSender {
  name: string;
  address: string;
}

export function buildFrom(configService: ConfigService): EmailSender {
  return {
    name: configService.getOrThrow<string>('EMAIL_FROM_NAME'),
    address: configService.getOrThrow<string>('EMAIL_FROM'),
  };
}
