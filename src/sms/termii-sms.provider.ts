import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsChannel, SmsProvider } from './sms-provider.interface';

@Injectable()
export class TermiiSmsProvider implements SmsProvider {
  readonly name = 'termii';

  constructor(private readonly configService: ConfigService) {}

  async send(phone: string, message: string, channel: SmsChannel): Promise<void> {
    const baseUrl = this.configService.get<string>('TERMII_BASE_URL', 'https://api.ng.termii.com');
    const response = await fetch(`${baseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.configService.getOrThrow<string>('TERMII_API_KEY'),
        to: phone,
        from: this.configService.getOrThrow<string>('TERMII_SENDER_ID'),
        sms: message,
        type: 'plain',
        channel,
      }),
    });

    const body = await response.json();
    if (!response.ok || body.code !== 'ok') {
      throw new Error(`Termii send failed: ${body.message ?? response.statusText}`);
    }
  }
}
