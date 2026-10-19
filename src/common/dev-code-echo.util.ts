import { ConfigService } from '@nestjs/config';

export function devCodeEcho(configService: ConfigService | undefined, code: string): string | undefined {
  return configService?.get('EMAIL_CODE_DEV_ECHO') === 'true' ? code : undefined;
}
